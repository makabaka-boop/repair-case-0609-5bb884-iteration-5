/** 单测/端到端共用：在内存中拼装 WAV 字节，无需任何外部文件 */

export interface WavBuildOptions {
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  frameCount?: number;
  formatTag?: number;
  riffTag?: string;
  waveTag?: string;
  riffSize?: number;
  fmtTag?: string;
  bitsOverride?: number;
  channelsOverride?: number;
  sampleRateOverride?: number;
  blockAlignOverride?: number;
  byteRateOverride?: number;
  includeData?: boolean;
  dataBytesOverride?: number;
  truncate?: number;
  /** 实际 PCM 帧采样值（交错），不足填 0；用于产出真实可解码的音频 */
  pcm?: ArrayLike<number>;
  extraChunks?: Array<{ id: string; size: number; odd?: boolean }>;
}

export function buildWavBytes(opts: WavBuildOptions = {}): ArrayBuffer {
  const channels = opts.channels ?? 1;
  const sampleRate = opts.sampleRate ?? 8000;
  const bits = opts.bitsPerSample ?? 16;
  const frameCount = opts.frameCount ?? 4;
  const blockAlign = channels * Math.ceil(bits / 8);
  const byteRate = sampleRate * blockAlign;
  const dataBytes = frameCount * blockAlign;

  const extra = opts.extraChunks ?? [];
  const extraBytes = extra.reduce(
    (n, c) => n + 8 + c.size + (c.odd ? 1 : 0),
    0
  );
  const riffSize = 36 + dataBytes + extraBytes;
  const total = 8 + riffSize;
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  const enc = (s: string, off: number) => {
    for (let i = 0; i < 4; i++) v.setUint8(off + i, s.charCodeAt(i));
  };

  enc(opts.riffTag ?? 'RIFF', 0);
  v.setUint32(4, opts.riffSize ?? riffSize, true);
  enc(opts.waveTag ?? 'WAVE', 8);

  enc(opts.fmtTag ?? 'fmt ', 12);
  v.setUint32(16, 16, true);
  v.setUint16(20, opts.formatTag ?? 1, true);
  v.setUint16(22, opts.channelsOverride ?? channels, true);
  v.setUint32(24, opts.sampleRateOverride ?? sampleRate, true);
  v.setUint32(28, opts.byteRateOverride ?? byteRate, true);
  v.setUint16(32, opts.blockAlignOverride ?? blockAlign, true);
  v.setUint16(34, opts.bitsOverride ?? bits, true);

  let off = 36;
  if (opts.includeData !== false) {
    enc('data', off);
    v.setUint32(off + 4, opts.dataBytesOverride ?? dataBytes, true);
    off += 8;
    if (opts.pcm) {
      for (
        let i = 0;
        i < opts.pcm.length && off + (i + 1) * 2 <= 8 + dataBytes;
        i++
      ) {
        v.setInt16(off + i * 2, Math.max(-32768, Math.min(32767, Math.round(opts.pcm[i]! * 32767))), true);
      }
    }
    off += dataBytes;
  }
  for (const c of extra) {
    enc(c.id, off);
    v.setUint32(off + 4, c.size, true);
    off += 8 + c.size;
    if (c.odd) off += 1;
  }

  return opts.truncate !== undefined ? buf.slice(0, opts.truncate) : buf;
}
