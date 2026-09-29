import { expect, test, type Page } from '@playwright/test';

/**
 * 局部视窗端到端验收：定位后各声道同步显示局部波形、
 * 边界平移保持宽度、短录音回退整轨、非法输入就地提示。
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

/** 游标（黄 #ffd34d）在画布中的水平位置（0..1），无游标返回 -1 */
async function cursorFraction(page: Page, canvasIndex: number): Promise<number> {
  return page.evaluate((idx) => {
    const canvas = document.querySelectorAll<HTMLCanvasElement>(
      '[data-testid="waveform-canvas"]'
    )[idx]!;
    const ctx = canvas.getContext('2d')!;
    const { data, width } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! > 220 && data[i + 1]! > 160 && data[i + 1]! < 240 && data[i + 2]! < 120) {
        sum += (i / 4) % width;
        count++;
      }
    }
    return count === 0 ? -1 : sum / count / width;
  }, canvasIndex);
}

/** 削波高亮（红）像素数与质心水平位置（0..1） */
async function redStats(
  page: Page,
  canvasIndex: number
): Promise<{ count: number; centroid: number }> {
  return page.evaluate((idx) => {
    const canvas = document.querySelectorAll<HTMLCanvasElement>(
      '[data-testid="waveform-canvas"]'
    )[idx]!;
    const ctx = canvas.getContext('2d')!;
    const { data, width } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (
        data[i + 1]! < 170 &&
        data[i]! - data[i + 1]! > 18 &&
        data[i]! - data[i + 2]! > 18 &&
        data[i + 3]! > 0
      ) {
        sum += (i / 4) % width;
        count++;
      }
    }
    return { count, centroid: count === 0 ? -1 : sum / count / width };
  }, canvasIndex);
}

test('中部长录音：定位后所有声道同步显示同一局部视窗', async ({ page }) => {
  await page.goto('/');
  // 8000Hz 立体声 30s；左声道 15s 处连续 5 帧削波，右声道干净
  const wav = buildWav({
    channels: 2,
    sampleRate: 8000,
    interleaved: makeInterleaved(2, 240000, [
      { start: 120000, end: 120004, targets: [0] }
    ])
  });
  await loadFile(page, wav, 'long-mid-clip.wav');
  await expect(page.getByTestId('verdict')).toHaveText('需重采');

  // 初始为整轨视图，返回整轨不可用
  await expect(page.getByTestId('view-range')).toHaveText(
    '当前视窗：0.000 – 30.000 s（宽度 30.000 s）'
  );
  await expect(page.getByTestId('back-to-full')).toBeDisabled();

  await page.getByTestId('locate-first').click();
  await pauseAudio(page);

  // 默认十秒视窗，以段起点 15s 为中心 → 10.000 – 20.000
  await expect(page.getByTestId('view-range')).toHaveText(
    '当前视窗：10.000 – 20.000 s（宽度 10.000 s）'
  );
  await expect(page.getByTestId('back-to-full')).toBeEnabled();

  // 播放器仍跳到段起点 15s
  const t = await audioTime(page);
  expect(t).toBeGreaterThan(14.5);
  expect(t).toBeLessThan(15.6);

  // 跨声道同步：两个声道的游标都落在画布中央（同一视窗起止）
  await expect.poll(() => cursorFraction(page, 0)).toBeGreaterThan(0.44);
  await expect.poll(() => cursorFraction(page, 1)).toBeGreaterThan(0.44);
  expect(await cursorFraction(page, 0)).toBeLessThan(0.56);
  expect(await cursorFraction(page, 1)).toBeLessThan(0.56);

  // 左声道削波高亮位于画布中央；右声道无削波高亮
  const left = await redStats(page, 0);
  const right = await redStats(page, 1);
  expect(left.count).toBeGreaterThan(20);
  expect(left.centroid).toBeGreaterThan(0.47);
  expect(left.centroid).toBeLessThan(0.53);
  expect(right.count).toBe(0);

  // 返回整轨恢复 0–30s
  await page.getByTestId('back-to-full').click();
  await expect(page.getByTestId('view-range')).toHaveText(
    '当前视窗：0.000 – 30.000 s（宽度 30.000 s）'
  );
});

test('边界削波：触及首尾时视窗只平移且保持指定宽度', async ({ page }) => {
  await page.goto('/');
  // 8000Hz 单声道 30s；0.5s 处（帧 4000..4004）削波
  const headWav = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: makeInterleaved(1, 240000, [{ start: 4000, end: 4004, targets: [0] }])
  });
  await loadFile(page, headWav, 'long-head-clip.wav');
  await expect(page.getByTestId('verdict')).toHaveText('需重采');

  // 指定 6 秒视窗：播放位置在 0，触及开头平移为 [0, 6]，宽度保持 6s
  await page.getByTestId('window-input').fill('6');
  await page.getByTestId('apply-window').click();
  await expect(page.getByTestId('view-range')).toHaveText(
    '当前视窗：0.000 – 6.000 s（宽度 6.000 s）'
  );

  // 定位 0.5s 处的削波：0.5 - 3 < 0，仍平移为 [0, 6]
  await page.getByTestId('locate-first').click();
  await pauseAudio(page);
  await expect(page.getByTestId('view-range')).toHaveText(
    '当前视窗：0.000 – 6.000 s（宽度 6.000 s）'
  );
  const tHead = await audioTime(page);
  expect(tHead).toBeGreaterThan(0.4);
  expect(tHead).toBeLessThan(1.0);
  // 削波高亮位于 0.5/6 ≈ 0.083 处（宽度确为 6s 而非更宽）
  const headRed = await redStats(page, 0);
  expect(headRed.count).toBeGreaterThan(20);
  expect(headRed.centroid).toBeGreaterThan(0.06);
  expect(headRed.centroid).toBeLessThan(0.11);

  // 换一段靠近结尾的削波：29.5s 处（帧 236000..236004），默认十秒视窗
  const tailWav = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: makeInterleaved(1, 240000, [
      { start: 236000, end: 236004, targets: [0] }
    ])
  });
  await loadFile(page, tailWav, 'long-tail-clip.wav');
  await expect(page.getByTestId('verdict')).toHaveText('需重采');
  await page.getByTestId('locate-first').click();
  await pauseAudio(page);
  // 29.5 + 5 > 30，触及结尾平移为 [20, 30]，宽度保持 10s
  await expect(page.getByTestId('view-range')).toHaveText(
    '当前视窗：20.000 – 30.000 s（宽度 10.000 s）'
  );
  const tailRed = await redStats(page, 0);
  expect(tailRed.centroid).toBeGreaterThan(0.93);
  expect(tailRed.centroid).toBeLessThan(0.97);
});

test('短录音：视窗不短于录音时回退整轨并提示', async ({ page }) => {
  await page.goto('/');
  // 8000Hz 单声道 5s；2.5s 处（帧 20000..20004）削波
  const wav = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: makeInterleaved(1, 40000, [
      { start: 20000, end: 20004, targets: [0] }
    ])
  });
  await loadFile(page, wav, 'short-clip.wav');
  await expect(page.getByTestId('verdict')).toHaveText('需重采');
  await expect(page.getByTestId('view-notice')).toHaveCount(0);

  // 默认十秒视窗 > 5s 录音：定位后回退整轨并提示
  await page.getByTestId('locate-first').click();
  await pauseAudio(page);
  await expect(page.getByTestId('view-notice')).toHaveText(
    '录音短于局部视窗，已显示整轨'
  );
  await expect(page.getByTestId('view-range')).toHaveText(
    '当前视窗：0.000 – 5.000 s（宽度 5.000 s）'
  );
  await expect(page.getByTestId('back-to-full')).toBeDisabled();

  // 播放器仍跳到段起点 2.5s
  const t = await audioTime(page);
  expect(t).toBeGreaterThan(2.0);
  expect(t).toBeLessThan(3.0);

  // 应用仍不短于录音的视窗秒数：保持整轨与提示
  await page.getByTestId('window-input').fill('8');
  await page.getByTestId('apply-window').click();
  await expect(page.getByTestId('view-notice')).toHaveText(
    '录音短于局部视窗，已显示整轨'
  );
  await expect(page.getByTestId('view-range')).toHaveText(
    '当前视窗：0.000 – 5.000 s（宽度 5.000 s）'
  );

  // 结论与区间不受影响
  await expect(page.getByTestId('verdict')).toHaveText('需重采');
  await expect(page.getByTestId('segment-row')).toHaveCount(1);
});

test('非法视窗输入：就地提示且不改变视图，已生成结果仍可操作', async ({ page }) => {
  await page.goto('/');
  // 8000Hz 双声道 80 帧；右声道帧 20..24 削波（5 帧 = 0.625ms → 1ms）
  const wav = buildWav({
    channels: 2,
    sampleRate: 8000,
    interleaved: makeInterleaved(2, 80, [{ start: 20, end: 24, targets: [1] }])
  });
  await loadFile(page, wav, 'invalid-window.wav');
  await expect(page.getByTestId('verdict')).toHaveText('需重采');
  await expect(page.getByTestId('total-clip-ms')).toHaveText('1 ms');
  const rangeBefore =
    (await page.getByTestId('view-range').textContent()) ?? '';

  // 非数字 / 不大于零 / 空输入：均就地提示且视图不变
  for (const bad of ['abc', '0', '']) {
    await page.getByTestId('window-input').fill(bad);
    await page.getByTestId('apply-window').click();
    await expect(page.getByTestId('window-error')).toHaveText(
      '局部视窗秒数必须大于零'
    );
    await expect(page.getByTestId('view-range')).toHaveText(rangeBefore);
  }

  // 原结论与区间仍然可见（起始 2.5ms→3ms、帧范围 20–24）
  await expect(page.getByTestId('verdict')).toHaveText('需重采');
  await expect(page.getByTestId('total-clip-ms')).toHaveText('1 ms');
  const rows = page.getByTestId('segment-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('20–24');
  await expect(page.getByTestId('locate-first')).toContainText('3 ms');

  // 区间仍可定位操作（短于视窗秒数 → 回退整轨并提示）
  await rows.nth(0).click();
  await pauseAudio(page);
  await expect.poll(() => audioTime(page)).toBeGreaterThan(0.001);
  await expect(page.getByTestId('view-range')).toHaveText(rangeBefore);
  await expect(page.getByTestId('view-notice')).toHaveText(
    '录音短于局部视窗，已显示整轨'
  );
});

test('首次应用新视窗秒数立即生效：宽度与输入同步，无需再次定位', async ({
  page
}) => {
  await page.goto('/');
  // 8000Hz 单声道 30s；15s 处（帧 120000..120004）削波
  const wav = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: makeInterleaved(1, 240000, [
      { start: 120000, end: 120004, targets: [0] }
    ])
  });
  await loadFile(page, wav, 'apply-width.wav');

  // 先用默认十秒视窗定位 15s：10 – 20
  await page.getByTestId('locate-first').click();
  await pauseAudio(page);
  await expect(page.getByTestId('view-range')).toHaveText(
    '当前视窗：10.000 – 20.000 s（宽度 10.000 s）'
  );

  // 播放位置停在 15s 附近，首次把视窗改为 6 秒并应用：必须立即以 15s 居中
  await page
    .getByTestId('audio-player')
    .evaluate((el) => ((el as HTMLAudioElement).currentTime = 15));
  await page.getByTestId('window-input').fill('6');
  await page.getByTestId('apply-window').click();
  await expect(page.getByTestId('view-range')).toHaveText(
    '当前视窗：12.000 – 18.000 s（宽度 6.000 s）'
  );
});

test('局部视窗波形内容与视窗时刻一致：开头脉冲不污染中后部局部视图', async ({
  page
}) => {
  await page.goto('/');
  // 8000Hz 单声道 30s；仅 2s 与 28s 附近各放一段 50ms 满幅脉冲
  const frames = new Array<number>(240000).fill(0);
  for (let f = 15800; f <= 16200; f++) frames[f] = 1;
  for (let f = 223800; f <= 224200; f++) frames[f] = 1;
  const wav = buildWav({ channels: 1, sampleRate: 8000, interleaved: frames });
  await loadFile(page, wav, 'wave-content.wav');

  // 以 28s 为关注时刻应用 7 秒视窗 → 28 + 3.5 > 30，触及结尾平移为 [23, 30]
  await page
    .getByTestId('audio-player')
    .evaluate((el) => ((el as HTMLAudioElement).currentTime = 28));
  await page.getByTestId('window-input').fill('7');
  await page.getByTestId('apply-window').click();
  await expect(page.getByTestId('view-range')).toHaveText(
    '当前视窗：23.000 – 30.000 s（宽度 7.000 s）'
  );

  // 视窗内唯一脉冲位于 28s → 画布 (28 - 23) / 7 ≈ 0.714 处；
  // 若波形误从录音开头绘制，视窗内的脉冲会来自 2s 处，落在 2/7 ≈ 0.286
  const pulse = await page.evaluate(() => {
    const canvas = document.querySelectorAll<HTMLCanvasElement>(
      '[data-testid="waveform-canvas"]'
    )[0]!;
    const ctx = canvas.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    const dpr = canvas.width / cssWidth;
    // 统计每个 CSS 像素列的蓝色像素数（波形蓝 #6ea8fe = (110,168,254)）
    const cols = new Array<number>(cssWidth).fill(0);
    for (let y = 0; y < cssHeight; y++) {
      for (let x = 0; x < cssWidth; x++) {
        const i =
          (Math.round(y * dpr) * canvas.width + Math.round(x * dpr)) * 4;
        if (
          data[i + 2]! > 200 &&
          data[i + 2]! - data[i]! > 60 &&
          data[i + 1]! > 120 &&
          data[i + 1]! < 210
        ) {
          cols[x]!++;
        }
      }
    }
    let sumX = 0;
    let count = 0;
    cols.forEach((c, x) => {
      sumX += x * c;
      count += c;
    });
    return { fraction: count === 0 ? -1 : sumX / count / cssWidth, count };
  });
  expect(pulse.count).toBeGreaterThan(20);
  expect(pulse.fraction).toBeGreaterThan(0.66);
  expect(pulse.fraction).toBeLessThan(0.77);
});

test('局部视窗内点击画布按视窗时刻定位：中点跳到视窗中部而非录音中点', async ({
  page
}) => {
  await page.goto('/');
  // 8000Hz 单声道 30s；15s 处削波（定位入口）
  const wav = buildWav({
    channels: 1,
    sampleRate: 8000,
    interleaved: makeInterleaved(1, 240000, [
      { start: 120000, end: 120004, targets: [0] }
    ])
  });
  await loadFile(page, wav, 'click-seek.wav');
  await page.getByTestId('locate-first').click();
  await pauseAudio(page);
  await expect(page.getByTestId('view-range')).toHaveText(
    '当前视窗：10.000 – 20.000 s（宽度 10.000 s）'
  );

  // 点击画布中点：应跳到视窗中点 15s；旧实现漏加视窗起点会跳到 5s
  const box = await page
    .getByTestId('waveform-canvas')
    .first()
    .boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect
    .poll(() => audioTime(page))
    .toBeGreaterThan(14.5);
  // 游标仍在可见区域内（15s 位于 10–20 视窗中央，水平比例 0.5）
  await expect.poll(() => cursorFraction(page, 0)).toBeGreaterThan(0.44);
  expect(await cursorFraction(page, 0)).toBeLessThan(0.56);
});
