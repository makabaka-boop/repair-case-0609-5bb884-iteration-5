/**
 * 结构完整性验收用的“固定字节样本”。
 *
 * 四类样本由同一套字节拼装代码产出，单元测试（ArrayBuffer）与
 * Playwright 端到端（Buffer.from(bytes)）共用，保证两种验收看到的是同一字节文件：
 *
 * 1. 区域外格式块：RIFF 声明区域内是完整合法 WAV，文件尾再附一个可解析的 fmt 块；
 * 2. 越界音频块：data 块体在物理文件内，但越过声明的 RIFF 区域末端；
 * 3. 半帧尾部：data 字节数不是完整采样帧的整数倍；
 * 4. 合法扩展块：RIFF 区域内含奇数尺寸 LIST（带对齐填充）的合法可解码 WAV。
 *
 * 仅使用 ArrayBuffer/DataView/Uint8Array，浏览器与 Node 均可运行。
 */

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/** 写入 16bit PCM fmt 块体（固定 16 字节，不含块头） */
function writePcmFmtBody(
  view: DataView,
  offset: number,
  channels: number,
  sampleRate: number
): void {
  const blockAlign = channels * 2;
  view.setUint16(offset, 1, true); // PCM
  view.setUint16(offset + 2, channels, true);
  view.setUint32(offset + 4, sampleRate, true);
  view.setUint32(offset + 8, sampleRate * blockAlign, true);
  view.setUint16(offset + 12, blockAlign, true);
  view.setUint16(offset + 14, 16, true);
}

/** 写入完整 16bit PCM fmt 块（8 字节头 + 16 字节体） */
function writePcmFmt(
  view: DataView,
  offset: number,
  channels: number,
  sampleRate: number
): void {
  writeAscii(view, offset, 'fmt ');
  view.setUint32(offset + 4, 16, true);
  writePcmFmtBody(view, offset + 8, channels, sampleRate);
}

/**
 * 样本 1：区域外格式块。
 *
 * 布局（单声道 / 8000Hz / 16bit / 4 帧）：
 * - [0, 52)  完整合法 WAV，RIFF 尺寸声明 44（riffEnd = 52）；
 * - [52, 76) 文件尾再附一个结构可解析的 fmt 块（8 字节头 + 16 字节体）。
 */
export function buildOutOfRegionFmtBytes(): Uint8Array {
  const dataBytes = 8; // 4 帧 × 2 字节
  const riffSize = 36 + dataBytes; // 44
  const trailingFmt = 8 + 16;
  const buf = new ArrayBuffer(8 + riffSize + trailingFmt);
  const v = new DataView(buf);

  writeAscii(v, 0, 'RIFF');
  v.setUint32(4, riffSize, true);
  writeAscii(v, 8, 'WAVE');
  writePcmFmt(v, 12, 1, 8000);
  writeAscii(v, 36, 'data');
  v.setUint32(40, dataBytes, true);
  // [44, 52) 为 4 帧静音 PCM（零值）

  // RIFF 区域之外、文件尾附带的可解析格式块
  writeAscii(v, 52, 'fmt ');
  v.setUint32(56, 16, true);
  writePcmFmtBody(v, 60, 2, 44100); // 体内容写什么不重要，它在区域外就必须被拒绝
  return new Uint8Array(buf);
}

/**
 * 样本 2：越界音频块。
 *
 * - RIFF 尺寸声明 36（riffEnd = 44），区域只覆盖到 data 块头结束；
 * - data 块声明 16 字节（8 帧），块体 [44, 60) 完全在物理文件内，
 *   却越过 RIFF 末端 44。
 */
export function buildDataBeyondRiffBytes(): Uint8Array {
  const dataBytes = 16; // 物理文件确实容纳 8 帧
  const riffSize = 36; // 声明区域末端 = 44
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);

  writeAscii(v, 0, 'RIFF');
  v.setUint32(4, riffSize, true);
  writeAscii(v, 8, 'WAVE');
  writePcmFmt(v, 12, 1, 8000); // [12, 36)，完全在区域内
  writeAscii(v, 36, 'data');
  v.setUint32(40, dataBytes, true);
  // [44, 60) 为物理存在但越过 RIFF 末端的数据
  return new Uint8Array(buf);
}

/**
 * 样本 3：半帧尾部。
 *
 * 立体声 / 16bit，帧大小 blockAlign = 4；data 声明 10 字节 = 2.5 帧，
 * 余数 2 字节恰为半个采样帧，且为偶数尺寸不涉及字对齐填充。
 * 旧逻辑 floor(10/4)=2 帧会带着截短帧数继续解码，新逻辑必须判 CORRUPT。
 */
export function buildHalfFrameTailBytes(): Uint8Array {
  const channels = 2;
  const dataBytes = 10; // 2 个完整帧 + 半个帧
  const riffSize = 36 + dataBytes; // 46
  const buf = new ArrayBuffer(8 + riffSize);
  const v = new DataView(buf);

  writeAscii(v, 0, 'RIFF');
  v.setUint32(4, riffSize, true);
  writeAscii(v, 8, 'WAVE');
  writePcmFmt(v, 12, channels, 8000);
  writeAscii(v, 36, 'data');
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

/**
 * 样本 4：合法扩展块。
 *
 * RIFF 区域内依次为 fmt、LIST（奇数尺寸 5 + 1 对齐填充）、data；
 * 单声道 / 8000Hz / 16bit / 80 帧静音，浏览器可真实解码，
 * 区域末端与物理文件末端严格一致。
 */
export function buildLegalExtensionBytes(): Uint8Array {
  const channels = 1;
  const sampleRate = 8000;
  const frameCount = 80;
  const dataBytes = frameCount * channels * 2;
  const listSize = 5;
  const listBytes = 8 + listSize + 1; // 奇数尺寸 + 1 字节对齐填充
  const riffSize = 36 + listBytes + dataBytes;
  const buf = new ArrayBuffer(8 + riffSize);
  const v = new DataView(buf);

  writeAscii(v, 0, 'RIFF');
  v.setUint32(4, riffSize, true);
  writeAscii(v, 8, 'WAVE');
  writePcmFmt(v, 12, channels, sampleRate);

  let off = 36;
  writeAscii(v, off, 'LIST');
  v.setUint32(off + 4, listSize, true);
  for (let i = 0; i < listSize; i++) v.setUint8(off + 8 + i, 0x41 + i);
  off += listBytes; // 跳过块体与填充字节

  writeAscii(v, off, 'data');
  v.setUint32(off + 4, dataBytes, true);
  return new Uint8Array(buf);
}

export interface StructureSample {
  key: string;
  fileName: string;
  bytes: Uint8Array;
}

/** 四份固定字节样本（顺序即验收描述顺序） */
export function buildStructureSamples(): {
  outOfRegionFmt: StructureSample;
  dataBeyondRiff: StructureSample;
  halfFrameTail: StructureSample;
  legalExtension: StructureSample;
} {
  return {
    outOfRegionFmt: {
      key: 'out-of-region-fmt',
      fileName: 'out-of-region-fmt.wav',
      bytes: buildOutOfRegionFmtBytes()
    },
    dataBeyondRiff: {
      key: 'data-beyond-riff',
      fileName: 'data-beyond-riff.wav',
      bytes: buildDataBeyondRiffBytes()
    },
    halfFrameTail: {
      key: 'half-frame-tail',
      fileName: 'half-frame-tail.wav',
      bytes: buildHalfFrameTailBytes()
    },
    legalExtension: {
      key: 'legal-extension',
      fileName: 'legal-extension.wav',
      bytes: buildLegalExtensionBytes()
    }
  };
}
