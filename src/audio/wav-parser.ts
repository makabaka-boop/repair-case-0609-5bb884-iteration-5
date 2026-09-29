/**
 * WAV(RIFF) 头解析：在交给 Web Audio 解码前先做结构校验，
 * 以便把“不是 WAV / 文件损坏 / 无音轨”区分成明确错误原因。
 * 纯字节解析，不做任何网络访问。
 */

import { WavError } from './types';

export interface WavHeaderInfo {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  formatTag: number;
  dataBytes: number;
  frameCount: number;
}

const PCM_TAG = 0x0001;
const FLOAT_TAG = 0x0003;
const EXTENSIBLE_TAG = 0xfffe;
const SUPPORTED_BITS = new Set([8, 16, 24, 32]);

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

export function parseWavHeader(bytes: ArrayBuffer): WavHeaderInfo {
  if (bytes.byteLength < 12) {
    throw new WavError('NOT_WAV', '文件过小，不是有效的 WAV 音频');
  }
  const view = new DataView(bytes);

  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new WavError('NOT_WAV', '缺少 RIFF/WAVE 标识，文件不是有效的 WAV 音频');
  }

  // RIFF 声明尺寸超出实际字节 => 被截断
  const riffSize = view.getUint32(4, true);
  const riffEnd = riffSize + 8; // RIFF 区域末端（不含）：8 字节头 + 声明尺寸
  if (riffEnd > bytes.byteLength) {
    throw new WavError('CORRUPT', `RIFF 声明 ${riffEnd} 字节，实际只有 ${bytes.byteLength} 字节，文件已损坏或被截断`);
  }
  // 声明尺寸至少要容纳 “WAVE” 四字节标识
  if (riffSize < 4) {
    throw new WavError('CORRUPT', `RIFF 声明尺寸 ${riffSize} 不足以容纳 WAVE 标识，文件已损坏`);
  }

  let fmt: {
    formatTag: number;
    channels: number;
    sampleRate: number;
    byteRate: number;
    blockAlign: number;
    bitsPerSample: number;
  } | null = null;
  let dataBytes = -1;

  // 区块只允许出现在 RIFF 声明区域 [12, riffEnd) 内：
  // 文件尾附带的“可解析区块”在区域之外，不能当成有效内容，
  // 否则不同浏览器可能各自报错或照常解码，判定会随环境漂移。
  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;
    // 区块体必须同时落在声明的 RIFF 区域与物理文件内
    if (bodyStart + chunkSize > riffEnd) {
      throw new WavError(
        'CORRUPT',
        `区块 "${chunkId}" 声明 ${chunkSize} 字节但越过 RIFF 区域末端，文件已损坏或被截断`
      );
    }

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) {
        throw new WavError('CORRUPT', 'fmt 区块长度不足 16 字节，文件已损坏');
      }
      fmt = {
        formatTag: view.getUint16(bodyStart, true),
        channels: view.getUint16(bodyStart + 2, true),
        sampleRate: view.getUint32(bodyStart + 4, true),
        byteRate: view.getUint32(bodyStart + 8, true),
        blockAlign: view.getUint16(bodyStart + 12, true),
        bitsPerSample: view.getUint16(bodyStart + 14, true)
      };
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
    }

    offset = bodyStart + chunkSize + (chunkSize & 1); // 奇数字节块按字对齐填充
    if (offset > riffEnd) {
      // 奇数尺寸区块声明了填充字节，但下一字节已越过 RIFF 区域末端
      throw new WavError(
        'CORRUPT',
        `区块 "${chunkId}" 的对齐填充超出 RIFF 区域末端，文件已损坏`
      );
    }
  }

  // 区块链必须恰好覆盖整个 RIFF 区域，且物理文件在区域末端后不得再有内容。
  // 区域外字节可能被部分浏览器解析为 fmt/data 块（结果随环境变化），
  // 一律在结构检查阶段稳定判定为损坏。
  if (offset !== riffEnd) {
    throw new WavError(
      'CORRUPT',
      `区块链在 RIFF 区域内残留 ${riffEnd - offset} 个无法解析的字节，文件已损坏`
    );
  }
  if (riffEnd < bytes.byteLength) {
    throw new WavError(
      'CORRUPT',
      `RIFF 区域已在第 ${riffEnd} 字节结束，文件尾仍附带 ${bytes.byteLength - riffEnd} 字节区域外数据，文件已损坏`
    );
  }

  if (fmt === null) {
    throw new WavError('CORRUPT', '缺少 fmt 区块，WAV 文件已损坏');
  }
  if (!SUPPORTED_BITS.has(fmt.bitsPerSample)) {
    throw new WavError(
      'CORRUPT',
      `不支持的位深 ${fmt.bitsPerSample}（仅支持 8/16/24/32 位），文件可能已损坏`
    );
  }
  if (fmt.channels < 1 || fmt.channels > 64) {
    throw new WavError('CORRUPT', `非法声道数 ${fmt.channels}，文件已损坏`);
  }
  if (fmt.sampleRate === 0 || fmt.sampleRate > 768000) {
    throw new WavError('CORRUPT', `非法采样率 ${fmt.sampleRate}，文件已损坏`);
  }
  const bytesPerSample = Math.ceil(fmt.bitsPerSample / 8);
  const expectedBlockAlign = bytesPerSample * fmt.channels;
  if (fmt.blockAlign !== expectedBlockAlign) {
    throw new WavError(
      'CORRUPT',
      `块对齐 ${fmt.blockAlign} 与声道/位深推算的 ${expectedBlockAlign} 不一致，文件已损坏`
    );
  }
  if (
    (fmt.formatTag === PCM_TAG || fmt.formatTag === FLOAT_TAG) &&
    fmt.byteRate !== fmt.sampleRate * fmt.blockAlign
  ) {
    throw new WavError(
      'CORRUPT',
      '字节率与采样率/块对齐不一致，文件已损坏'
    );
  }
  if (
    fmt.formatTag !== PCM_TAG &&
    fmt.formatTag !== FLOAT_TAG &&
    fmt.formatTag !== EXTENSIBLE_TAG
  ) {
    // 结构像 WAV，但编码（如 ADPCM、μ-law）交给解码器尝试；失败则归为解码失败。
    // 此处不直接拒绝，避免误杀可解码文件。
  }

  if (dataBytes < 0) {
    throw new WavError('NO_TRACK', 'WAV 文件不含 data 区块，没有可读取的音轨');
  }

  // data 长度必须是完整采样帧的整数倍；尾部不足一帧属于结构损坏，
  // 不能向下取整成较短帧数继续扫描（否则会产出截短后的比较结果）。
  if (dataBytes % fmt.blockAlign !== 0) {
    throw new WavError(
      'CORRUPT',
      `data 区块 ${dataBytes} 字节不能被帧大小 ${fmt.blockAlign} 整除，尾部存在残缺采样帧，文件已损坏`
    );
  }

  const frameCount = dataBytes / fmt.blockAlign;
  if (frameCount === 0) {
    throw new WavError('NO_TRACK', 'data 区块中没有任何完整音频帧，文件不含可读取的音轨');
  }

  return {
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    formatTag: fmt.formatTag,
    dataBytes,
    frameCount
  };
}
