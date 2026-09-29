import { expect, test, type Page } from '@playwright/test';

/**
 * 候选规则比较端到端验收：
 * 无差异、结论翻转（两个方向）、非法输入保留上一次有效比较、换文件清理。
 * WAV 素材全部在浏览器页面内现场生成（16bit PCM），文件不离开本机。
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
  buf.writeUInt16LE(1, 20); // PCM
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

/** 静音交错帧序列；start/end 为帧区间（含），targets 指定削波声道（0 起） */
function makeInterleaved(
  channels: number,
  frameCount: number,
  clips: Array<{ start: number; end: number; targets: number[]; value?: number }>
): number[] {
  const data = new Array<number>(channels * frameCount).fill(0);
  for (const clip of clips) {
    for (let f = clip.start; f <= clip.end; f++) {
      for (const ch of clip.targets) {
        data[f * channels + ch] = clip.value ?? 1;
      }
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

async function pauseAudio(page: Page): Promise<void> {
  await page
    .getByTestId('audio-player')
    .evaluate((el) => (el as HTMLAudioElement).pause());
}

async function audioTime(page: Page): Promise<number> {
  return page
    .getByTestId('audio-player')
    .evaluate((el) => (el as HTMLAudioElement).currentTime);
}

/** 差异条着色像素计数：橙=仅基线，绿=仅候选，灰=两者共有 */
async function countStripPixels(
  page: Page,
  canvasIndex: number,
  color: 'orange' | 'green' | 'slate'
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
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        if (data[i + 3] === 0) continue;
        if (c === 'orange' && r > 220 && g > 90 && g < 170 && b < 110) n++;
        if (c === 'green' && g > 160 && r > 40 && r < 140 && b < 90) n++;
        if (
          c === 'slate' &&
          r > 120 &&
          r < 180 &&
          g > 130 &&
          g < 195 &&
          b > 150 &&
          b < 215 &&
          b - r < 60
        )
          n++;
      }
      return n;
    },
    [canvasIndex, color] as const
  );
}

/** 原红色削波层高亮像素数（验证比较开启后红层保持不变） */
async function countRedPixels(page: Page, canvasIndex: number): Promise<number> {
  return page.evaluate((idx) => {
    const canvas = document.querySelectorAll<HTMLCanvasElement>(
      '[data-testid="waveform-canvas"]'
    )[idx]!;
    const ctx = canvas.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let red = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (
        data[i + 1]! < 170 &&
        data[i]! - data[i + 1]! > 18 &&
        data[i]! - data[i + 2]! > 18 &&
        data[i + 3]! > 0
      )
        red++;
    }
    return red;
  }, canvasIndex);
}

/** 8000Hz 单声道 100 帧，帧 40..44 满幅削波（5 帧，基线 1 段） */
function fiveFrameClipWav(): Buffer {
  return buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: makeInterleaved(1, 100, [{ start: 40, end: 44, targets: [0] }])
  });
}

test('候选规则与基线一致：无差异，差异条仅共有标记', async ({ page }) => {
  await page.goto('/');
  await loadFile(page, fiveFrameClipWav(), 'no-diff.wav');
  await expect(page.getByTestId('verdict')).toHaveText('需重采');
  // 未启用比较时：无比较摘要、无差异行
  await expect(page.getByTestId('compare-summary')).toHaveCount(0);
  await expect(page.getByTestId('diff-row')).toHaveCount(0);

  // 默认输入即基线规则（0.999 / 3 帧 / 2 帧），直接应用
  await page.getByTestId('apply-rule').click();

  await expect(page.getByTestId('compare-summary')).toBeVisible();
  await expect(page.getByTestId('baseline-verdict')).toHaveText('需重采');
  await expect(page.getByTestId('candidate-verdict')).toHaveText('需重采');
  await expect(page.getByTestId('baseline-count')).toHaveText('1 段');
  await expect(page.getByTestId('candidate-count')).toHaveText('1 段');
  await expect(page.getByTestId('diff-summary')).toHaveText(
    '差异片段：新增 0 · 漏掉 0 · 共有 1'
  );
  await expect(page.getByTestId('no-diff')).toBeVisible();

  // 差异表仅一行 BOTH，帧范围与基线段一致
  const rows = page.getByTestId('diff-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toHaveAttribute('data-membership', 'BOTH');
  await expect(rows.nth(0)).toContainText('两者共有');
  await expect(rows.nth(0)).toContainText('40–44');

  // 波形差异条：仅灰色（两者共有），无橙/绿
  expect(await countStripPixels(page, 0, 'slate')).toBeGreaterThan(20);
  expect(await countStripPixels(page, 0, 'orange')).toBe(0);
  expect(await countStripPixels(page, 0, 'green')).toBe(0);
  // 原红色削波层保持不变
  expect(await countRedPixels(page, 0)).toBeGreaterThan(20);
});

test('候选规则变严：结论翻转为可交付，漏掉片段可定位试听', async ({ page }) => {
  await page.goto('/');
  await loadFile(page, fiveFrameClipWav(), 'flip-strict.wav');
  await expect(page.getByTestId('verdict')).toHaveText('需重采');

  // 最短连续帧 10：5 帧削波不再成段
  await page.getByTestId('rule-min-run').fill('10');
  await page.getByTestId('apply-rule').click();

  // 两套结论并列：基线需重采 1 段，候选可交付 0 段
  await expect(page.getByTestId('baseline-verdict')).toHaveText('需重采');
  await expect(page.getByTestId('candidate-verdict')).toHaveText('可交付');
  await expect(page.getByTestId('baseline-count')).toHaveText('1 段');
  await expect(page.getByTestId('candidate-count')).toHaveText('0 段');
  await expect(page.getByTestId('diff-summary')).toHaveText(
    '差异片段：新增 0 · 漏掉 1 · 共有 0'
  );
  await expect(page.getByTestId('no-diff')).toHaveCount(0);

  // 差异表一行 BASELINE_ONLY，点击定位试听（40/8000 = 5ms）
  const rows = page.getByTestId('diff-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toHaveAttribute('data-membership', 'BASELINE_ONLY');
  await expect(rows.nth(0)).toContainText('仅基线');
  await rows.nth(0).click();
  await pauseAudio(page);
  await expect.poll(() => audioTime(page)).toBeGreaterThan(0.004);

  // 波形：橙色（仅基线）差异条出现，原红色削波层仍在
  expect(await countStripPixels(page, 0, 'orange')).toBeGreaterThan(20);
  expect(await countRedPixels(page, 0)).toBeGreaterThan(20);
  // 基线区间列表不受比较影响，仍为 1 行
  await expect(page.getByTestId('segment-row')).toHaveCount(1);
});

test('候选规则放宽：结论翻转为需重采，新增片段绿色标记', async ({ page }) => {
  await page.goto('/');
  // 2 帧尖峰（帧 70..71）：基线（3 帧）不成段 → 可交付
  const wav = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: makeInterleaved(1, 100, [{ start: 70, end: 71, targets: [0] }])
  });
  await loadFile(page, wav, 'flip-loose.wav');
  await expect(page.getByTestId('verdict')).toHaveText('可交付');

  // 最短连续帧 1：尖峰成段
  await page.getByTestId('rule-min-run').fill('1');
  await page.getByTestId('apply-rule').click();

  await expect(page.getByTestId('baseline-verdict')).toHaveText('可交付');
  await expect(page.getByTestId('candidate-verdict')).toHaveText('需重采');
  await expect(page.getByTestId('baseline-count')).toHaveText('0 段');
  await expect(page.getByTestId('candidate-count')).toHaveText('1 段');
  await expect(page.getByTestId('diff-summary')).toHaveText(
    '差异片段：新增 1 · 漏掉 0 · 共有 0'
  );

  const rows = page.getByTestId('diff-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toHaveAttribute(
    'data-membership',
    'CANDIDATE_ONLY'
  );
  await expect(rows.nth(0)).toContainText('仅候选');
  await expect(rows.nth(0)).toContainText('70–71');

  // 绿色（仅候选）差异条
  expect(await countStripPixels(page, 0, 'green')).toBeGreaterThan(10);
  expect(await countStripPixels(page, 0, 'orange')).toBe(0);
});

test('非法候选输入：就地提示并保留上一次有效比较', async ({ page }) => {
  await page.goto('/');
  await loadFile(page, fiveFrameClipWav(), 'invalid-rule.wav');
  await expect(page.getByTestId('verdict')).toHaveText('需重采');

  // 先应用一次合法规则：候选可交付
  await page.getByTestId('rule-min-run').fill('10');
  await page.getByTestId('apply-rule').click();
  await expect(page.getByTestId('candidate-verdict')).toHaveText('可交付');
  await expect(page.getByTestId('diff-row')).toHaveCount(1);

  // 非法阈值（0 / 大于 1 / 非数字）：均就地提示，比较结果不变
  for (const bad of ['0', '1.5', 'abc']) {
    await page.getByTestId('rule-threshold').fill(bad);
    await page.getByTestId('apply-rule').click();
    await expect(page.getByTestId('rule-error')).toContainText('候选规则非法');
    await expect(page.getByTestId('candidate-verdict')).toHaveText('可交付');
    await expect(page.getByTestId('baseline-verdict')).toHaveText('需重采');
    await expect(page.getByTestId('diff-row')).toHaveCount(1);
    await expect(page.getByTestId('diff-summary')).toHaveText(
      '差异片段：新增 0 · 漏掉 1 · 共有 0'
    );
  }
  // 恢复合法阈值
  await page.getByTestId('rule-threshold').fill('0.999');

  // 非法帧数（0 / 负数 / 小数）：同样保留上一次有效比较
  for (const bad of ['0', '-2', '2.5']) {
    await page.getByTestId('rule-min-run').fill(bad);
    await page.getByTestId('apply-rule').click();
    await expect(page.getByTestId('rule-error')).toContainText('候选规则非法');
    await expect(page.getByTestId('candidate-verdict')).toHaveText('可交付');
    await expect(page.getByTestId('diff-row')).toHaveCount(1);
  }

  // 非法合并间隔（负数 / 小数）
  await page.getByTestId('rule-min-run').fill('10');
  for (const bad of ['-1', '0.5']) {
    await page.getByTestId('rule-max-gap').fill(bad);
    await page.getByTestId('apply-rule').click();
    await expect(page.getByTestId('rule-error')).toContainText('候选规则非法');
    await expect(page.getByTestId('candidate-verdict')).toHaveText('可交付');
  }

  // 改回合法输入应用：提示消除，比较按新规则刷新
  await page.getByTestId('rule-max-gap').fill('2');
  await page.getByTestId('rule-min-run').fill('3');
  await page.getByTestId('apply-rule').click();
  await expect(page.getByTestId('rule-error')).toHaveCount(0);
  await expect(page.getByTestId('candidate-verdict')).toHaveText('需重采');
  await expect(page.getByTestId('no-diff')).toBeVisible();
});

test('换文件或解码失败：清空旧比较结果', async ({ page }) => {
  await page.goto('/');
  await loadFile(page, fiveFrameClipWav(), 'first.wav');
  await expect(page.getByTestId('verdict')).toHaveText('需重采');

  // 启用比较：候选可交付
  await page.getByTestId('rule-min-run').fill('10');
  await page.getByTestId('apply-rule').click();
  await expect(page.getByTestId('compare-summary')).toBeVisible();
  await expect(page.getByTestId('diff-row')).toHaveCount(1);

  // 载入新文件：旧比较必须清空，输入回到基线默认值
  const clean = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: new Array<number>(80).fill(0.01)
  });
  await loadFile(page, clean, 'second.wav');
  await expect(page.getByTestId('verdict')).toHaveText('可交付');
  await expect(page.getByTestId('compare-summary')).toHaveCount(0);
  await expect(page.getByTestId('diff-row')).toHaveCount(0);
  await expect(page.getByTestId('clear-comparison')).toHaveCount(0);
  await expect(page.getByTestId('rule-min-run')).toHaveValue('3');
  await expect(page.getByTestId('rule-threshold')).toHaveValue('0.999');
  await expect(page.getByTestId('rule-max-gap')).toHaveValue('2');

  // 再次启用比较后载入损坏文件：解码失败同样清空比较
  await page.getByTestId('apply-rule').click();
  await expect(page.getByTestId('compare-summary')).toBeVisible();
  const truncated = fiveFrameClipWav().subarray(0, 60);
  await loadFile(page, truncated, 'broken.wav');
  await expect(page.getByTestId('error-panel')).toBeVisible();
  await expect(page.getByTestId('error-title')).toContainText('CORRUPT');
  await expect(page.getByTestId('compare-summary')).toHaveCount(0);
  await expect(page.getByTestId('diff-row')).toHaveCount(0);

  // 失败后再载入有效文件：不残留任何旧比较
  await loadFile(page, fiveFrameClipWav(), 'third.wav');
  await expect(page.getByTestId('verdict')).toHaveText('需重采');
  await expect(page.getByTestId('compare-summary')).toHaveCount(0);
  await expect(page.getByTestId('diff-row')).toHaveCount(0);
});
