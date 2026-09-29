import { expect, test, type Page } from '@playwright/test';

/**
 * 返工文件对照端到端验收：
 * 1. 合成移位 PCM：仅靠锚点 NCC 对齐，把录制起点错位与真实修复区分开；
 * 2. 静音 / 能量不足锚点不得强行对齐；
 * 3. 多声道：修复只发生在指定声道，偏移对所有声道一致；
 * 4. 快速换文件：返工解码失败保留旧对照、新基线清空对照、迟到结果不覆盖。
 * WAV 素材全部在页面内现场生成（16bit PCM），文件不离开本机。
 */

function buildWav(opts: {
  channels: number;
  sampleRate: number;
  interleaved: number[];
}): Buffer {
  const { channels, sampleRate, interleaved } = opts;
  const blockAlign = channels * 2;
  const dataBytes = interleaved.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < interleaved.length; i++) {
    const s = Math.max(-32768, Math.min(32767, Math.round(interleaved[i]! * 32767)));
    buf.writeInt16LE(s, 44 + i * 2);
  }
  return buf;
}

/** 确定的多频“有效声音”：NCC 可区分不同帧偏移；scale 控制幅度 */
function tonalAt(frame: number, scale: number): number {
  const t = frame;
  return (
    scale *
    (0.6 * Math.sin((2 * Math.PI * t) / 17) +
      0.4 * Math.sin((2 * Math.PI * t) / 7.3 + 1.1))
  );
}

interface ReworkSpec {
  channels: number;
  sampleRate: number;
  baseFrames: number;
  /** 返工晚开始 shift 帧（reworkFrame = baseFrame + shift），可负 */
  shift: number;
  /** 返工总帧数；缺省为 baseFrames + |shift|（保证平移内容完整保留） */
  reworkFrames?: number;
  /** 原件削波段（按声道给出帧区间，含端点，≥3 帧） */
  baseClips?: Array<{ channel: number; start: number; end: number }>;
  /** 返工中保留的削波段（返工坐标）；未列出的基线段视为已修复 */
  reworkClips?: Array<{ channel: number; start: number; end: number }>;
  /** 有效声音铺底的声道与幅度（缺省所有声道 0.5） */
  tonalChannels?: number[];
  scale?: number;
}

/** 生成原件与返工两份交错 PCM；返工按 shift 平移声音并替换削波段 */
function makePair(spec: ReworkSpec): { base: Buffer; rework: Buffer } {
  const { channels, sampleRate, baseFrames, shift } = spec;
  const scale = spec.scale ?? 0.5;
  const tonalOn = new Set(spec.tonalChannels ?? channels === 1 ? [0] : [0, 1]);

  const reworkFrames = spec.reworkFrames ?? baseFrames + Math.abs(shift);
  const base = new Array<number>(channels * baseFrames).fill(0);
  const rework = new Array<number>(channels * reworkFrames).fill(0);

  // 有效声音铺底（避开削波段，使锚点处是干净声音）
  for (let f = 0; f < baseFrames; f++) {
    for (let c = 0; c < channels; c++) {
      if (!tonalOn.has(c)) continue;
      base[f * channels + c] = tonalAt(f, scale);
      const rf = f + shift;
      if (rf >= 0 && rf < reworkFrames) {
        rework[rf * channels + c] = tonalAt(f, scale);
      }
    }
  }
  // 原件削波（满幅覆盖铺底）
  for (const clip of spec.baseClips ?? []) {
    for (let f = clip.start; f <= clip.end; f++) {
      base[f * channels + clip.channel] = 1;
    }
  }
  // 返工保留/新引入削波（返工坐标，满幅）
  for (const clip of spec.reworkClips ?? []) {
    for (let f = clip.start; f <= clip.end; f++) {
      if (f >= 0 && f < reworkFrames) rework[f * channels + clip.channel] = 1;
    }
  }
  return {
    base: buildWav({ channels, sampleRate, interleaved: base }),
    rework: buildWav({ channels, sampleRate, interleaved: rework })
  };
}

async function loadFile(page: Page, buffer: Buffer, testid: string, name: string) {
  const promise = page.waitForEvent('filechooser');
  await page.getByTestId(testid).click();
  const chooser = await promise;
  await chooser.setFiles({ name, mimeType: 'audio/wav', buffer });
}

async function pauseBoth(page: Page) {
  await page
    .getByTestId('audio-player')
    .evaluate((el) => (el as HTMLAudioElement).pause());
  await page
    .getByTestId('rework-audio-player')
    .evaluate((el) => (el as HTMLAudioElement).pause());
}

async function playerTime(page: Page, testid: string): Promise<number> {
  return page
    .getByTestId(testid)
    .evaluate((el) => (el as HTMLAudioElement).currentTime);
}

test('合成移位 PCM：锚点 NCC 找出 +37 帧偏移，错位段判未修复而非误报', async ({
  page
}) => {
  await page.goto('/');
  // 原件两段削波：[40,44] 返工中保留（随录音起点后移到 77..81）；
  // [120,124] 返工中消失（确实修复）。返工晚开始 37 帧。
  const { base, rework } = makePair({
    channels: 1,
    sampleRate: 8000,
    baseFrames: 400,
    shift: 37,
    baseClips: [
      { channel: 0, start: 40, end: 44 },
      { channel: 0, start: 120, end: 124 }
    ],
    // 保留段平移到返工坐标 40+37=77
    reworkClips: [{ channel: 0, start: 77, end: 81 }]
  });
  await loadFile(page, base, 'file-input', 'orig.wav');
  await expect(page.getByTestId('verdict')).toHaveText('需重采');
  await expect(page.getByTestId('segment-row')).toHaveCount(2);

  await loadFile(page, rework, 'rework-input', 'redo.wav');
  await expect(page.getByTestId('rework-meta')).toContainText('redo.wav');

  // 锚点：原件 0.01s 起、0.05s 长（位于干净声音区），±80 帧，声道 0
  await page.getByTestId('anchor-start').fill('0.01');
  await page.getByTestId('anchor-length').fill('0.02');
  await page.getByTestId('anchor-max-offset').fill('80');
  await page.getByTestId('apply-anchor').click();

  await expect(page.getByTestId('rework-offset')).toHaveText('+37 帧');
  await expect(page.getByTestId('rework-counts')).toHaveText(
    '已修复（仅原件）1 · 新引入（仅返工）0 · 仍削波（两边共有）1 · 不可比较 0'
  );

  const rows = page.getByTestId('rework-diff-row');
  await expect(rows).toHaveCount(2);
  // 未修复段：原件 40–44 / 返工 77–81
  const both = page.locator('[data-testid="rework-diff-row"][data-membership="BOTH"]');
  await expect(both).toHaveCount(1);
  await expect(both).toContainText('40–44');
  await expect(both).toContainText('77–81');
  // 已修复段：仅原件 120–124
  const fixed = page.locator(
    '[data-testid="rework-diff-row"][data-membership="BASELINE_ONLY"]'
  );
  await expect(fixed).toHaveCount(1);
  await expect(fixed).toContainText('120–124');
  // 双波形面板存在且每声道两行波形
  await expect(page.getByTestId('rework-channel')).toHaveCount(1);
  await expect(
    page.locator('[data-testid="rework-channel"] canvas')
  ).toHaveCount(2);
});

test('定位试听：同一差异片段分别映射到原件与返工件坐标', async ({ page }) => {
  await page.goto('/');
  const { base, rework } = makePair({
    channels: 1,
    sampleRate: 8000,
    baseFrames: 400,
    shift: 37,
    baseClips: [{ channel: 0, start: 40, end: 44 }],
    reworkClips: [{ channel: 0, start: 77, end: 81 }]
  });
  await loadFile(page, base, 'file-input', 'orig2.wav');
  await loadFile(page, rework, 'rework-input', 'redo2.wav');
  await page.getByTestId('anchor-start').fill('0.01');
  await page.getByTestId('anchor-length').fill('0.02');
  await page.getByTestId('apply-anchor').click();
  await expect(page.getByTestId('rework-offset')).toHaveText('+37 帧');

  await page
    .locator('[data-testid="rework-diff-row"][data-membership="BOTH"]')
    .click();
  await pauseBoth(page);
  // 原件定位 40/8000=0.005s；返工定位 77/8000=0.009625s
  await expect.poll(() => playerTime(page, 'audio-player')).toBeGreaterThan(0.004);
  await expect
    .poll(() => playerTime(page, 'rework-audio-player'))
    .toBeGreaterThan(0.009);
});

test('静音锚点：报能量不足，不生成对齐结果，不能强行对齐', async ({ page }) => {
  await page.goto('/');
  // 锚点区域为静音；两端放一点削波供基线扫描（600 帧）
  const channels = 1;
  const sr = 8000;
  const frames = 600;
  const data = new Array<number>(channels * frames).fill(0);
  for (let f = 10; f <= 14; f++) data[f] = 1;
  for (let f = 560; f <= 564; f++) data[f] = 1;
  const base = buildWav({ channels, sampleRate: sr, interleaved: data });
  const rework = buildWav({
    channels,
    sampleRate: sr,
    interleaved: new Array<number>(channels * frames).fill(0)
  });
  await loadFile(page, base, 'file-input', 'silent-anchor.wav');
  await loadFile(page, rework, 'rework-input', 'silent-anchor-redo.wav');

  await page.getByTestId('anchor-start').fill('0.03'); // 帧 240，落在静音区
  await page.getByTestId('anchor-length').fill('0.02'); // 160 帧全静音（240..399）
  await page.getByTestId('apply-anchor').click();

  await expect(page.getByTestId('anchor-error')).toContainText('锚点能量不足');
  await expect(page.getByTestId('rework-summary')).toHaveCount(0);
  await expect(page.getByTestId('rework-diff-row')).toHaveCount(0);
});

test('多声道：仅右声道修复，左声道仍削波，偏移对两声道一致', async ({ page }) => {
  await page.goto('/');
  const { base, rework } = makePair({
    channels: 2,
    sampleRate: 8000,
    baseFrames: 400,
    shift: -12, // 返工早开始 12 帧
    baseClips: [
      { channel: 0, start: 100, end: 104 }, // 左：未修复（随偏移到 88..92）
      { channel: 1, start: 100, end: 104 } // 右：返工修复
    ],
    reworkClips: [{ channel: 0, start: 88, end: 92 }],
    tonalChannels: [0, 1]
  });
  await loadFile(page, base, 'file-input', 'stereo-orig.wav');
  await loadFile(page, rework, 'rework-input', 'stereo-redo.wav');

  // 用声道 0（左）定锚
  await page.getByTestId('anchor-start').fill('0.02');
  await page.getByTestId('anchor-length').fill('0.02');
  await page.getByTestId('anchor-max-offset').fill('80');
  await page.getByTestId('anchor-channel').fill('0');
  await page.getByTestId('apply-anchor').click();

  await expect(page.getByTestId('rework-offset')).toHaveText('−12 帧');
  await expect(page.getByTestId('rework-counts')).toHaveText(
    '已修复（仅原件）1 · 新引入（仅返工）0 · 仍削波（两边共有）1 · 不可比较 0'
  );
  // 两个声道卡片各自一条差异
  const cards = page.getByTestId('rework-channel');
  await expect(cards).toHaveCount(2);
  await expect(
    cards.nth(0).locator('[data-membership="BOTH"]')
  ).toHaveCount(1);
  await expect(
    cards.nth(1).locator('[data-membership="BASELINE_ONLY"]')
  ).toHaveCount(1);
});

test('返工解码失败：保留已确认旧对照；再载入新基线则清空', async ({ page }) => {
  await page.goto('/');
  const { base, rework } = makePair({
    channels: 1,
    sampleRate: 8000,
    baseFrames: 400,
    shift: 37,
    baseClips: [{ channel: 0, start: 40, end: 44 }],
    reworkClips: [{ channel: 0, start: 77, end: 81 }]
  });
  await loadFile(page, base, 'file-input', 'keep.wav');
  await loadFile(page, rework, 'rework-input', 'keep-redo.wav');
  await page.getByTestId('anchor-start').fill('0.01');
  await page.getByTestId('anchor-length').fill('0.02');
  await page.getByTestId('apply-anchor').click();
  await expect(page.getByTestId('rework-offset')).toHaveText('+37 帧');
  await expect(page.getByTestId('rework-diff-row')).toHaveCount(1);

  // 再选一个损坏的“返工文件”：解码失败，旧对照保留
  const broken = rework.subarray(0, 60);
  await loadFile(page, broken, 'rework-input', 'broken-redo.wav');
  await expect(page.getByTestId('rework-error')).toBeVisible();
  await expect(page.getByTestId('rework-error')).toContainText('CORRUPT');
  await expect(page.getByTestId('rework-error')).toContainText('保留此前确认的对照');
  // 旧对照仍在
  await expect(page.getByTestId('rework-offset')).toHaveText('+37 帧');
  await expect(page.getByTestId('rework-diff-row')).toHaveCount(1);
  // 返工播放器仍可试听（旧对象 URL 未被失败结果释放）
  await expect(page.getByTestId('rework-audio-player')).toBeVisible();

  // 载入新基线：返工对照必须整体清空
  const clean = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: new Array<number>(120).fill(0.01)
  });
  await loadFile(page, clean, 'file-input', 'new-base.wav');
  await expect(page.getByTestId('verdict')).toHaveText('可交付');
  await expect(page.getByTestId('rework-summary')).toHaveCount(0);
  await expect(page.getByTestId('rework-diff-row')).toHaveCount(0);
  await expect(page.getByTestId('rework-meta')).toHaveCount(0);
});

test('快速换文件：迟到的返工载入/对齐结果不能覆盖较新文件', async ({ page }) => {
  await page.goto('/');
  const { base, rework } = makePair({
    channels: 1,
    sampleRate: 8000,
    baseFrames: 400,
    shift: 37,
    baseClips: [{ channel: 0, start: 40, end: 44 }],
    reworkClips: [{ channel: 0, start: 77, end: 81 }]
  });
  await loadFile(page, base, 'file-input', 'fast.wav');
  await loadFile(page, rework, 'rework-input', 'fast-redo-a.wav');
  await page.getByTestId('anchor-start').fill('0.01');
  await page.getByTestId('anchor-length').fill('0.02');

  // 连续快速换两次返工文件：最终只承认最后一次选择
  await loadFile(page, rework, 'rework-input', 'fast-redo-b.wav');
  const meta = page.getByTestId('rework-meta');
  await expect(meta).toContainText('fast-redo-b.wav');
  await page.getByTestId('apply-anchor').click();
  await expect(page.getByTestId('rework-offset')).toHaveText('+37 帧');

  // 对齐后快速换基线：旧对照与旧返工必须清空，迟到结果无入口写回
  const clean = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: new Array<number>(120).fill(0.01)
  });
  await loadFile(page, clean, 'file-input', 'fast-new-base.wav');
  await expect(page.getByTestId('rework-summary')).toHaveCount(0);
  await expect(page.getByTestId('rework-input')).toBeVisible();
});

test('非法锚点输入：就地提示并保留上一次已确认对照', async ({ page }) => {
  await page.goto('/');
  const { base, rework } = makePair({
    channels: 1,
    sampleRate: 8000,
    baseFrames: 400,
    shift: 37,
    baseClips: [{ channel: 0, start: 40, end: 44 }],
    reworkClips: [{ channel: 0, start: 77, end: 81 }]
  });
  await loadFile(page, base, 'file-input', 'inv.wav');
  await loadFile(page, rework, 'rework-input', 'inv-redo.wav');
  await page.getByTestId('anchor-start').fill('0.01');
  await page.getByTestId('anchor-length').fill('0.02');
  await page.getByTestId('apply-anchor').click();
  await expect(page.getByTestId('rework-offset')).toHaveText('+37 帧');

  for (const bad of ['-0.1', 'abc', '']) {
    await page.getByTestId('anchor-start').fill(bad);
    await page.getByTestId('apply-anchor').click();
    await expect(page.getByTestId('anchor-error')).toContainText('锚点参数非法');
    await expect(page.getByTestId('rework-offset')).toHaveText('+37 帧');
    await expect(page.getByTestId('rework-diff-row')).toHaveCount(1);
  }
  // 锚点起点超出文件长度：参数能解析但对齐报越界，旧对照仍保留
  await page.getByTestId('anchor-start').fill('999');
  await page.getByTestId('apply-anchor').click();
  await expect(page.getByTestId('anchor-error')).toContainText('超出基线文件帧数');
  await expect(page.getByTestId('rework-diff-row')).toHaveCount(1);
});

test('未覆盖区域标记不可比较，不算任何一侧独有', async ({ page }) => {
  await page.goto('/');
  // 原件 400 帧、返工 200 帧且晚开始 37 帧：
  // 真实重叠（原件坐标）= [0, 162]。锚点取帧 24..143（0.003..0.018s），
  // 落在重叠内；原件削波段 [40,44] 在重叠内（返工平移保留，判 BOTH），
  // 原件 [200,204] 超出返工覆盖 → BASELINE_UNCOMPARED。
  const { base, rework } = makePair({
    channels: 1,
    sampleRate: 8000,
    baseFrames: 400,
    reworkFrames: 200,
    shift: 37,
    baseClips: [
      { channel: 0, start: 40, end: 44 },
      { channel: 0, start: 200, end: 204 }
    ],
    reworkClips: [{ channel: 0, start: 77, end: 81 }]
  });
  await loadFile(page, base, 'file-input', 'tail.wav');
  await loadFile(page, rework, 'rework-input', 'tail-redo.wav');
  await page.getByTestId('anchor-start').fill('0.003');
  await page.getByTestId('anchor-length').fill('0.015');
  await page.getByTestId('apply-anchor').click();

  await expect(page.getByTestId('rework-offset')).toHaveText('+37 帧');
  await expect(page.getByTestId('rework-counts')).toContainText('不可比较 1');
  const uncomp = page.locator(
    '[data-testid="rework-diff-row"][data-membership="BASELINE_UNCOMPARED"]'
  );
  await expect(uncomp).toHaveCount(1);
  await expect(uncomp).toContainText('200–204');
  // 未比较片段的返工坐标列必须是占位符而不是伪造帧号
  await expect(uncomp).toContainText('—');
  // 且绝不能被判成“仅原件（已修复）”
  await expect(
    page.locator('[data-testid="rework-diff-row"][data-membership="BASELINE_ONLY"]')
  ).toHaveCount(0);
});
