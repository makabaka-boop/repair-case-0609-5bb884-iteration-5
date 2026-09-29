import { expect, test, type Page } from '@playwright/test';

/**
 * 端到端验收：全部 WAV 素材在浏览器页面内现场生成（16bit PCM），
 * 经 setInputFiles 交给应用，由 Web Audio API 真实解码。
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
  clips: Array<{ start: number; end: number; targets: number[] }>
): number[] {
  const data = new Array<number>(channels * frameCount).fill(0);
  for (const clip of clips) {
    for (let f = clip.start; f <= clip.end; f++) {
      for (const ch of clip.targets) {
        data[f * channels + ch] = 1;
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

/** 统计画布中红色削波高亮像素数（rgba(255,77,79,*) 底纹/描边） */
async function countRedPixels(page: Page, canvasIndex: number): Promise<number> {
  return page.evaluate((idx) => {
    const canvas = document.querySelectorAll<HTMLCanvasElement>(
      '[data-testid="waveform-canvas"]'
    )[idx]!;
    const ctx = canvas.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let red = 0;
    for (let i = 0; i < data.length; i += 4) {
      // 削波红 (255,77,79) 含半透明底纹（与暗底混合后红通道仍明显占优）；
      // 波形蓝、游标黄均不满足 r 显著大于 g/b
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

test('载入双声道样例：仅实际削波声道高亮，结论需重采并显示总削波时长', async ({ page }) => {
  await page.goto('/');

  // 8000Hz 双声道 80 帧；左声道帧 10..12（连续 3 帧）削波，右声道干净
  const wav = buildWav({
    channels: 2,
    sampleRate: 8000,
    interleaved: makeInterleaved(2, 80, [{ start: 10, end: 12, targets: [0] }])
  });
  await loadFile(page, wav, 'stereo-left-clip.wav');

  await expect(page.getByTestId('verdict')).toHaveText('需重采');
  await expect(page.getByTestId('total-clip-ms')).toHaveText('0 ms');

  const cards = page.getByTestId('channel-card');
  await expect(cards).toHaveCount(2);

  const stats = page.getByTestId('channel-stat');
  await expect(stats.nth(0)).toContainText('1 段');
  await expect(stats.nth(1)).toHaveText('无削波段');

  // 左声道区间列表一行：起始 10/8000=1.25ms→1ms，结束 13/8000=1.625ms→2ms
  const rows = cards.nth(0).getByTestId('segment-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('1');
  await expect(rows.nth(0)).toContainText('2');

  // 右声道列表为空提示
  await expect(cards.nth(1).getByText('该声道未检出削波段')).toBeVisible();

  // 两个声道都渲染了波形画布
  await expect(page.getByTestId('waveform-canvas')).toHaveCount(2);

  // 像素级断言：仅左声道画布含红色削波高亮，右声道 0 个红像素
  const leftRed = await countRedPixels(page, 0);
  const rightRed = await countRedPixels(page, 1);
  expect(leftRed).toBeGreaterThan(20);
  expect(rightRed).toBe(0);
});

test('双声道同一时刻削波：总削波时长按声道累加（分别计入）', async ({ page }) => {
  await page.goto('/');
  // 8000Hz 双声道 160 帧；帧 8..15（8 帧）两声道同时削波
  const wav = buildWav({
    channels: 2,
    sampleRate: 8000,
    interleaved: makeInterleaved(2, 160, [{ start: 8, end: 15, targets: [0, 1] }])
  });
  await loadFile(page, wav, 'stereo-both-clip.wav');

  await expect(page.getByTestId('verdict')).toHaveText('需重采');
  // 每声道 8 帧 = 1ms，累加 = 2ms（同一时刻分别计入）
  await expect(page.getByTestId('total-clip-ms')).toHaveText('2 ms');
  const stats = page.getByTestId('channel-stat');
  await expect(stats.nth(0)).toContainText('合计 1 ms');
  await expect(stats.nth(1)).toContainText('合计 1 ms');
});

test('干净单声道样例：结论可交付，无区间无定位按钮', async ({ page }) => {
  await page.goto('/');
  const wav = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: new Array<number>(80).fill(0.01)
  });
  await loadFile(page, wav, 'clean.wav');

  await expect(page.getByTestId('verdict')).toHaveText('可交付');
  await expect(page.getByTestId('total-clip-ms')).toHaveText('0 ms');
  await expect(page.getByTestId('locate-first')).toHaveCount(0);
  await expect(page.getByTestId('segment-row')).toHaveCount(0);
  await expect(page.getByText('该声道未检出削波段')).toBeVisible();
});

test('点击“定位首个异常”可定位到首个异常时刻', async ({ page }) => {
  await page.goto('/');
  // 8000Hz 双声道 80 帧；右声道帧 20..24 削波（5 帧），左声道干净
  const wav = buildWav({
    channels: 2,
    sampleRate: 8000,
    interleaved: makeInterleaved(2, 80, [{ start: 20, end: 24, targets: [1] }])
  });
  await loadFile(page, wav, 'stereo-right-clip.wav');

  const locate = page.getByTestId('locate-first');
  await expect(locate).toBeVisible();
  // 按钮文案直接标出首个异常声道与起始毫秒：20/8000=2.5ms→3ms（0.5 向上）
  await expect(locate).toContainText('右声道');
  await expect(locate).toContainText('3 ms');

  await locate.click();
  const audioEl = page.getByTestId('audio-player');
  // HTMLAudioElement.currentTime 量化粒度较粗（实测约 10ms），
  // 验证定位落在首个异常时刻 2.5ms 的合理容差内，且确已离开起点
  await expect
    .poll(async () => audioEl.evaluate((el) => (el as HTMLAudioElement).currentTime))
    .toBeGreaterThan(0);
  const currentTime = await audioEl.evaluate((el) => {
    const a = el as HTMLAudioElement;
    a.pause();
    return a.currentTime;
  });
  expect(currentTime).toBeGreaterThan(0.001);
  expect(currentTime).toBeLessThan(0.05);
});

test('点击区间行可定位试听', async ({ page }) => {
  await page.goto('/');
  // 8000Hz：帧 40..44（5 帧）削波，起始 40/8000=5ms
  const wav = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: makeInterleaved(1, 100, [{ start: 40, end: 44, targets: [0] }])
  });
  await loadFile(page, wav, 'mono-clip.wav');
  await page.getByTestId('segment-row').first().click();
  const audio = page.getByTestId('audio-player');
  await expect
    .poll(async () => audio.evaluate((el) => (el as HTMLAudioElement).currentTime))
    .toBeGreaterThan(0.004);
});

test('截断损坏的 WAV：显示明确原因且不生成结果', async ({ page }) => {
  await page.goto('/');
  const wav = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: makeInterleaved(1, 100, [{ start: 0, end: 10, targets: [0] }])
  });
  const truncated = wav.subarray(0, 60); // RIFF 声明远大于实际
  await loadFile(page, truncated, 'broken.wav');

  await expect(page.getByTestId('error-panel')).toBeVisible();
  await expect(page.getByTestId('error-title')).toContainText('CORRUPT');
  await expect(page.getByTestId('error-title')).toContainText('损坏');
  await expect(page.getByTestId('summary-panel')).toHaveCount(0);
  await expect(page.getByTestId('verdict')).toHaveCount(0);
});

test('无音轨 WAV（data 区块为 0 帧）：显示无音轨原因且不生成结果', async ({ page }) => {
  await page.goto('/');
  // 手搓 0 帧 WAV
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(0, 40);
  await loadFile(page, buf, 'empty-track.wav');

  await expect(page.getByTestId('error-panel')).toBeVisible();
  await expect(page.getByTestId('error-title')).toContainText('NO_TRACK');
  await expect(page.getByTestId('error-title')).toContainText('音轨');
  await expect(page.getByTestId('summary-panel')).toHaveCount(0);
});

test('非 WAV 文件：显示不是有效 WAV 且不生成结果', async ({ page }) => {
  await page.goto('/');
  await loadFile(page, Buffer.from('not a wav file at all, just plain text'), 'note.txt');
  await expect(page.getByTestId('error-panel')).toBeVisible();
  await expect(page.getByTestId('error-title')).toContainText('NOT_WAV');
  await expect(page.getByTestId('summary-panel')).toHaveCount(0);
});
