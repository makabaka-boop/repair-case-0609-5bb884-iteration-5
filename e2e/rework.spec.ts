import { expect, test, type Page } from '@playwright/test';

/**
 * 返工文件对照端到端验收：
 * 合成移位 PCM 的唯一对齐（最高相关度/最小绝对偏移/正号）、
 * 真实削波修复 vs 仅起点错位、静音锚点不强行对齐、多声道、快速换文件隔离。
 * WAV 素材全部浏览器内现场生成（16bit PCM），文件不离开本机。
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

/** 确定性 LCG 噪声（非周期、能量充足），模拟有效说话声 */
function noise(length: number, seed = 12345): Float32Array {
  let s = seed >>> 0;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const v = (s % 2000) / 1000 - 1; // -1..1
    // 叠加慢速包络，避免恒定音量；整体保持高能量
    out[i] = v * (0.25 + 0.5 * Math.abs(Math.sin(i * 0.07)));
  }
  return out;
}

function monoFrame(data: Float32Array): number[] {
  return Array.from(data);
}

/** 把单声道 Float32 样本整体平移 shift 帧（rework[f]=base[f-shift]），不足补 0 */
function shiftedMono(base: Float32Array, shift: number, frames: number): Float32Array {
  const out = new Float32Array(frames);
  for (let r = 0; r < frames; r++) {
    const b = r - shift;
    if (b >= 0 && b < base.length) out[r] = base[b]!;
  }
  return out;
}

function setClips(
  data: Float32Array,
  clips: Array<[number, number]>
): Float32Array {
  for (const [s, e] of clips) {
    for (let f = s; f <= e; f++) {
      if (f >= 0 && f < data.length) data[f] = 1;
    }
  }
  return data;
}

async function loadFile(page: Page, buffer: Buffer, name: string): Promise<void> {
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('file-input').click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles({ name, mimeType: 'audio/wav', buffer });
}

async function loadRework(page: Page, buffer: Buffer, name: string): Promise<void> {
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('rework-input').click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles({ name, mimeType: 'audio/wav', buffer });
}

async function fillAnchor(
  page: Page,
  anchor: { start: string; duration: string; channel?: string; maxOffset?: string }
): Promise<void> {
  await page.getByTestId('anchor-start').fill(anchor.start);
  await page.getByTestId('anchor-duration').fill(anchor.duration);
  if (anchor.channel) await page.getByTestId('anchor-channel').fill(anchor.channel);
  if (anchor.maxOffset) {
    await page.getByTestId('anchor-max-offset').fill(anchor.maxOffset);
  }
}

/** 统计第 idx 个波形画布上指定返工标记颜色的像素数 */
async function countMarkPixels(
  page: Page,
  canvasIndex: number,
  color: 'green' | 'red' | 'slate' | 'dark'
): Promise<number> {
  return page.evaluate(
    ([idx, c]) => {
      const canvas = document.querySelectorAll<HTMLCanvasElement>(
        '[data-testid="waveform-canvas"]'
      )[idx]!;
      const ctx = canvas.getContext('2d')!;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        if (c === 'green' && g > 150 && r < 150 && b < 190 && g - r > 40) n++;
        if (c === 'red' && r > 200 && g < 120 && b < 120) n++;
        if (
          c === 'slate' &&
          r > 120 &&
          r < 190 &&
          g > 130 &&
          g < 200 &&
          b > 150 &&
          b < 220 &&
          Math.abs(r - g) < 40
        )
          n++;
        if (c === 'dark' && r > 70 && r < 140 && g > 80 && g < 150 && b > 100 && b < 180)
          n++;
      }
      return n;
    },
    [canvasIndex, color] as const
  );
}

test('合成移位 PCM：锚点对齐给出唯一偏移，错位不被当成质量变化', async ({ page }) => {
  await page.goto('/');
  const SR = 8000;
  const frames = 8000;
  // 基线：噪声录音 + 帧 4000..4004 五帧满幅削波
  const base = setClips(noise(frames, 99), [[4000, 4004]]);
  // 返工整体晚 30 帧，削波随内容平移到 4030..4034（同一段内容，不是修复）
  const rework = setClips(shiftedMono(base, 30, frames + 60), []);

  await loadFile(page, buildWav({ channels: 1, sampleRate: SR, interleaved: monoFrame(base) }), 'base.wav');
  await expect(page.getByTestId('verdict')).toHaveText('需重采');
  await loadRework(page, buildWav({ channels: 1, sampleRate: SR, interleaved: monoFrame(rework) }), 'rework-shift.wav');
  await expect(page.getByTestId('rework-meta')).toBeVisible();

  // 锚点选在帧 1000..1800（0.125s 起、0.1s 时长），远离削波
  await fillAnchor(page, { start: '0.125', duration: '0.1', maxOffset: '200' });
  await page.getByTestId('apply-alignment').click();

  await expect(page.getByTestId('rework-offset')).toHaveText('+30 帧');
  await expect(page.getByTestId('rework-offset')).toHaveAttribute('data-sign', '+');
  const scoreText = await page.getByTestId('rework-score').textContent();
  expect(Number(scoreText)).toBeGreaterThan(0.99);
  // 重叠区内削波随内容平移 → BOTH，无真实质量变化
  await expect(page.getByTestId('rework-diff-summary')).toContainText('已修复 0');
  await expect(page.getByTestId('rework-diff-summary')).toContainText('新增 0');
  await expect(page.getByTestId('rework-no-real-diff')).toBeVisible();
  const rows = page.getByTestId('rework-diff-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toHaveAttribute('data-kind', 'BOTH');

  // 双波形：两侧共有灰色标记
  const canvases = page.getByTestId('waveform-canvas');
  // 主声道卡画布为 0；返工面板两个画布在其后（基线、返工）
  const total = await canvases.count();
  expect(total).toBe(3);
  expect(await countMarkPixels(page, 1, 'slate')).toBeGreaterThan(10);
  expect(await countMarkPixels(page, 2, 'slate')).toBeGreaterThan(10);
});

test('返工真实修复：重叠区基线段消失判 FIXED，可定位试听且分别映射坐标', async ({ page }) => {
  await page.goto('/');
  const SR = 8000;
  const frames = 8000;
  const base = setClips(noise(frames, 7), [[4000, 4004]]);
  // 返工整体晚 10 帧，但削波被修复（对应位置只保留低幅噪声）
  const rework = shiftedMono(base, 10, frames + 20);
  for (let f = 4010; f <= 4014; f++) rework[f] = 0.02;

  await loadFile(page, buildWav({ channels: 1, sampleRate: SR, interleaved: monoFrame(base) }), 'base.wav');
  await loadRework(page, buildWav({ channels: 1, sampleRate: SR, interleaved: monoFrame(rework) }), 'rework-fixed.wav');
  await fillAnchor(page, { start: '0.125', duration: '0.1', maxOffset: '100' });
  await page.getByTestId('apply-alignment').click();

  await expect(page.getByTestId('rework-offset')).toHaveText('+10 帧');
  await expect(page.getByTestId('rework-real-diff')).toBeVisible();
  await expect(page.getByTestId('rework-diff-summary')).toContainText('已修复 1');
  const rows = page.getByTestId('rework-diff-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toHaveAttribute('data-kind', 'FIXED');
  await expect(rows.nth(0)).toContainText('4000'); // 基线起始 ms（帧 4000/8000=500ms）
  await expect(rows.nth(0)).toContainText('4010'); // 返工起始 ms（帧 4010/8000）

  // 绿色“已修复”标记出现在返工面板的基线波形上
  expect(await countMarkPixels(page, 1, 'green')).toBeGreaterThan(10);

  // 定位试听：两个播放器分别跳到各自坐标（基线 0.5s，返工 0.50125s）
  await rows.nth(0).click();
  await page
    .getByTestId('audio-player')
    .evaluate((el) => (el as HTMLAudioElement).pause());
  await page
    .getByTestId('rework-audio-player')
    .evaluate((el) => (el as HTMLAudioElement).pause());
  const baseTime = await page
    .getByTestId('audio-player')
    .evaluate((el) => (el as HTMLAudioElement).currentTime);
  const reworkTime = await page
    .getByTestId('rework-audio-player')
    .evaluate((el) => (el as HTMLAudioElement).currentTime);
  expect(baseTime).toBeGreaterThan(0.499);
  expect(baseTime).toBeLessThan(0.502);
  expect(reworkTime).toBeGreaterThan(0.500);
  expect(reworkTime).toBeLessThan(0.503);
  expect(Math.abs(reworkTime - baseTime - 10 / 8000)).toBeLessThan(0.002);
});

test('静音/低能量锚点不强行对齐：就地提示且不产生对照', async ({ page }) => {
  await page.goto('/');
  const SR = 8000;
  // 基线前半静音、后半有削波（在 6000 帧处）；锚点选在静音区
  const base = new Float32Array(8000);
  for (let f = 6000; f <= 6004; f++) base[f] = 1;
  const rework = shiftedMono(base, 12, 8000);

  await loadFile(page, buildWav({ channels: 1, sampleRate: SR, interleaved: monoFrame(base) }), 'silent-anchor.wav');
  await loadRework(page, buildWav({ channels: 1, sampleRate: SR, interleaved: monoFrame(rework) }), 'r.wav');

  // 静音锚点：0.1s 起、0.1s 时长，全是 0
  await fillAnchor(page, { start: '0.1', duration: '0.1', maxOffset: '100' });
  await page.getByTestId('apply-alignment').click();
  await expect(page.getByTestId('align-error')).toContainText('能量不足');
  await expect(page.getByTestId('rework-summary')).toHaveCount(0);
  await expect(page.getByTestId('rework-diff-row')).toHaveCount(0);

  // 低能量锚点（0.001 常量）同样拒绝
  const quiet = new Float32Array(8000).fill(0.001);
  await loadFile(page, buildWav({ channels: 1, sampleRate: SR, interleaved: monoFrame(quiet) }), 'quiet.wav');
  await loadRework(page, buildWav({ channels: 1, sampleRate: SR, interleaved: monoFrame(new Float32Array(8000).fill(0.001)) }), 'q2.wav');
  await fillAnchor(page, { start: '0.1', duration: '0.1', maxOffset: '100' });
  await page.getByTestId('apply-alignment').click();
  await expect(page.getByTestId('align-error')).toContainText('能量不足');
  await expect(page.getByTestId('rework-summary')).toHaveCount(0);
});

test('非法锚点输入：就地提示并保留上一次有效对照', async ({ page }) => {
  await page.goto('/');
  const SR = 8000;
  const base = setClips(noise(8000, 31), [[4000, 4004]]);
  const rework = shiftedMono(base, 30, 8060);

  await loadFile(page, buildWav({ channels: 1, sampleRate: SR, interleaved: monoFrame(base) }), 'b.wav');
  await loadRework(page, buildWav({ channels: 1, sampleRate: SR, interleaved: monoFrame(rework) }), 'r.wav');
  await fillAnchor(page, { start: '0.125', duration: '0.1', maxOffset: '200' });
  await page.getByTestId('apply-alignment').click();
  await expect(page.getByTestId('rework-offset')).toHaveText('+30 帧');

  for (const bad of ['', '-1', 'abc']) {
    await page.getByTestId('anchor-start').fill(bad);
    await page.getByTestId('apply-alignment').click();
    await expect(page.getByTestId('align-error')).toContainText('锚点输入非法');
    await expect(page.getByTestId('rework-offset')).toHaveText('+30 帧');
  }
  // 时长过短（低于最少帧数 16/8000=0.002s，用 0.001）
  await page.getByTestId('anchor-start').fill('0.125');
  await page.getByTestId('anchor-duration').fill('0.001');
  await page.getByTestId('apply-alignment').click();
  await expect(page.getByTestId('align-error')).toContainText('锚点时长过短');
  await expect(page.getByTestId('rework-offset')).toHaveText('+30 帧');
});

test('多声道：左声道修复（FIXED）与右声道新增（NEW）逐声道裁决', async ({ page }) => {
  await page.goto('/');
  const SR = 8000;
  const frames = 8000;
  const shift = -8; // 返工早 8 帧
  const shiftCh = (src: Float32Array): Float32Array => shiftedMono(src, shift, frames);

  const leftBase = setClips(noise(frames, 55), [[4000, 4004]]);
  const rightBase = noise(frames, 77);
  const leftRework = shiftCh(leftBase);
  for (let f = 3992; f <= 3996; f++) leftRework[f] = 0.03; // 左削波被修复
  const rightRework = shiftCh(rightBase);
  for (let f = 5000; f <= 5004; f++) rightRework[f] = 1; // 右新增

  const interleave = (l: Float32Array, r: Float32Array): number[] => {
    const out: number[] = [];
    for (let i = 0; i < l.length; i++) out.push(l[i]!, r[i]!);
    return out;
  };
  await loadFile(
    page,
    buildWav({ channels: 2, sampleRate: SR, interleaved: interleave(leftBase, rightBase) }),
    'stereo.wav'
  );
  await loadRework(
    page,
    buildWav({ channels: 2, sampleRate: SR, interleaved: interleave(leftRework, rightRework) }),
    'stereo-r.wav'
  );
  await fillAnchor(page, { start: '0.125', duration: '0.1', channel: '0', maxOffset: '100' });
  await page.getByTestId('apply-alignment').click();

  await expect(page.getByTestId('rework-offset')).toHaveText('-8 帧');
  const blocks = page.getByTestId('rework-channel-block');
  await expect(blocks).toHaveCount(2);

  const rows0 = blocks.nth(0).getByTestId('rework-diff-row');
  await expect(rows0).toHaveCount(1);
  await expect(rows0.nth(0)).toHaveAttribute('data-kind', 'FIXED');

  const rows1 = blocks.nth(1).getByTestId('rework-diff-row');
  await expect(rows1).toHaveCount(1);
  await expect(rows1.nth(0)).toHaveAttribute('data-kind', 'NEW');

  await expect(page.getByTestId('rework-diff-summary')).toContainText('已修复 1 · 新增 1');
});

test('返工解码失败保留旧对照；新基线载入清空；迟到结果不覆盖新文件', async ({ page }) => {
  await page.goto('/');
  const SR = 8000;
  const base = setClips(noise(8000, 121), [[4000, 4004]]);
  const goodRework = shiftedMono(base, 30, 8060);

  await loadFile(page, buildWav({ channels: 1, sampleRate: SR, interleaved: monoFrame(base) }), 'b.wav');
  await loadRework(page, buildWav({ channels: 1, sampleRate: SR, interleaved: monoFrame(goodRework) }), 'good.wav');
  await fillAnchor(page, { start: '0.125', duration: '0.1', maxOffset: '200' });
  await page.getByTestId('apply-alignment').click();
  await expect(page.getByTestId('rework-offset')).toHaveText('+30 帧');
  await expect(page.getByTestId('rework-diff-row')).toHaveCount(1);

  // 再选一个损坏返工：解码失败，旧对照保留
  const truncated = buildWav({
    channels: 1,
    sampleRate: SR,
    interleaved: monoFrame(goodRework)
  }).subarray(0, 60);
  await loadRework(page, truncated, 'broken.wav');
  await expect(page.getByTestId('rework-error')).toContainText('CORRUPT');
  await expect(page.getByTestId('rework-offset')).toHaveText('+30 帧');
  await expect(page.getByTestId('rework-diff-row')).toHaveCount(1);
  await expect(page.getByTestId('rework-audio-player')).toBeVisible();

  // 快速换文件：立刻选择另一份规格不一致的返工（声道数不同），
  // 其失败结果到来后页面只反映最后一次选择，不串回旧状态以外的内容
  const stereo = buildWav({
    channels: 2,
    sampleRate: SR,
    interleaved: (() => {
      const out: number[] = [];
      for (let i = 0; i < 8000; i++) out.push(0.01, 0.01);
      return out;
    })()
  });
  await loadRework(page, stereo, 'stereo-ok.wav');
  // 新返工成功载入：meta 更新为双声道，基于旧返工 PCM 的对照必须清空
  await expect(page.getByTestId('rework-meta')).toContainText('2 声道');
  await expect(page.getByTestId('rework-offset')).toHaveCount(0);
  await expect(page.getByTestId('rework-diff-row')).toHaveCount(0);

  // 重新载入基线文件：返工面板回到无文件状态
  await loadFile(page, buildWav({ channels: 1, sampleRate: SR, interleaved: monoFrame(base) }), 'b2.wav');
  await expect(page.getByTestId('rework-meta')).toHaveCount(0);
  await expect(page.getByTestId('rework-audio-player')).toHaveCount(0);
});

test('未覆盖区域标记不可比较，不计入任何一侧独有', async ({ page }) => {
  await page.goto('/');
  const SR = 8000;
  // 基线 8000 帧，削波在末尾帧 7990..7994；返工只有 4000 帧、整体晚 30 帧
  const base = setClips(noise(8000, 202), [[7990, 7994]]);
  const reworkData = shiftedMono(base, 30, 4000);

  await loadFile(page, buildWav({ channels: 1, sampleRate: SR, interleaved: monoFrame(base) }), 'b.wav');
  await loadRework(page, buildWav({ channels: 1, sampleRate: SR, interleaved: monoFrame(reworkData) }), 'short.wav');
  // 锚点选在共同覆盖的前段
  await fillAnchor(page, { start: '0.1', duration: '0.1', maxOffset: '100' });
  await page.getByTestId('apply-alignment').click();
  await expect(page.getByTestId('rework-offset')).toHaveText('+30 帧');
  // 基线段完全落在返工覆盖之外 → BASELINE_ONLY（不可比较），不计 FIXED
  await expect(page.getByTestId('rework-diff-summary')).toContainText('已修复 0');
  const rows = page.getByTestId('rework-diff-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toHaveAttribute('data-kind', 'BASELINE_ONLY');
  // 返工起始列为 “—”
  await expect(rows.nth(0)).toContainText('不可比较');
});
