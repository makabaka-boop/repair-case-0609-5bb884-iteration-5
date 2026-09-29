/**
 * 锚点对齐（纯函数）。
 *
 * 返工文件与原始文件的录制起点可能相差几十帧，直接逐帧比较会把这种
 * 错位误判成削波质量变化。质检员在基线文件上选取一段“有效声音”作锚点，
 * 在限定帧偏移范围内对两份已解码 PCM 做归一化互相关（NCC）：
 *
 * - 偏移 d 表示返工帧 = 基线帧 + d（d>0 返工晚开始，d<0 返工早开始）；
 * - 相关度 NCC(d) = Σ(a·b) / sqrt(Σa²·Σb²)，与整体幅度无关；
 * - 裁决顺序固定为：最高相关度 → 最小绝对偏移 → 偏移符号（负优先），
 *   因此同一组数据永远得到唯一对齐结果；
 * - 静音或能量不足的锚点（任一窗口 RMS 低于阈值，或分母为 0）
 *   不得强行对齐，直接判失败。
 *
 * 纯计算、不复制整段 PCM、不触碰 DOM 与网络。
 */

/** 锚点参数：质检员在基线文件上选取的一段有效声音 */
export interface AnchorParams {
  /** 锚点首帧（基线坐标，非负整数） */
  anchorStartFrame: number;
  /** 锚点长度（帧，正整数） */
  anchorLengthFrames: number;
  /** 限定帧偏移范围：在 [-maxOffsetFrames, +maxOffsetFrames] 内搜索 */
  maxOffsetFrames: number;
  /** 对齐所用声道序号（0 起）；多声道文件逐声道比较时用同一声道定偏移 */
  channel: number;
}

/** 输入参数校验失败（非锚点能量问题） */
export type AnchorParamErrorCode =
  | 'ANCHOR_OUT_OF_RANGE'
  | 'ANCHOR_TOO_SHORT'
  | 'INVALID_MAX_OFFSET'
  | 'CHANNEL_MISMATCH';

/** 锚点本身静音或能量不足，不允许强行对齐 */
export const ANCHOR_LOW_ENERGY = 'ANCHOR_LOW_ENERGY' as const;

/** 对齐失败原因 */
export type AnchorError =
  | { kind: 'PARAM'; code: AnchorParamErrorCode; message: string }
  | { kind: AnchorErrorCode; message: string };

export type AnchorErrorCode = typeof ANCHOR_LOW_ENERGY;

/**
 * 锚点能量阈值：锚点窗口与候选窗口的 RMS 都必须达到该值才允许相关。
 * 归一化 PCM 下 0.01 远高于静音底噪，又远低于正常语音/有效声音。
 */
export const ANCHOR_MIN_RMS = 0.01;

/** 一次成功对齐的唯一结果 */
export interface AlignmentResult {
  /** 返工帧 = 基线帧 + offsetFrames（可负） */
  offsetFrames: number;
  /** 命中偏移处的归一化互相关度（约 [-1, 1]，成功时为正） */
  score: number;
  /** 参与相关的帧数（= 锚点长度） */
  comparedFrames: number;
  /** 锚点窗口 RMS（用于页面展示能量是否充足） */
  anchorRms: number;
}

function paramError(
  code: AnchorParamErrorCode,
  message: string
): AnchorError {
  return { kind: 'PARAM', code, message };
}

function isNonNegativeInt(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}
function isPositiveInt(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

/**
 * 计算一个窗口的 RMS（均方根能量）。
 * 调用方保证 start/end 在 data 范围内。
 */
export function windowRms(
  data: Float32Array,
  start: number,
  length: number
): number {
  let sumSq = 0;
  for (let i = 0; i < length; i++) {
    const v = data[start + i]!;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / length);
}

/**
 * 两个等长窗口的皮尔逊相关（去均值），能量不足或零方差返回 null。
 *
 * 去均值后再归一化，避免两份录音直流电平不同把相关度整体抬高；
 * 分母任一为 0（恒定值窗口，包括静音）即无法归一化，返回 null。
 */
function normalizedCorrelation(
  a: Float32Array,
  aStart: number,
  b: Float32Array,
  bStart: number,
  length: number
): { score: number; rmsB: number } | null {
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < length; i++) {
    sumA += a[aStart + i]!;
    sumB += b[bStart + i]!;
  }
  const meanA = sumA / length;
  const meanB = sumB / length;

  let dot = 0;
  let varA = 0;
  let varB = 0;
  let sumSqB = 0;
  for (let i = 0; i < length; i++) {
    const x = a[aStart + i]! - meanA;
    const y = b[bStart + i]! - meanB;
    dot += x * y;
    varA += x * x;
    varB += y * y;
    sumSqB += b[bStart + i]! * b[bStart + i]!;
  }
  // 去均值后零方差（恒定窗口）或原始能量过低：不可归一化
  if (varA <= 0 || varB <= 0) return null;
  const rmsB = Math.sqrt(sumSqB / length);
  if (rmsB < ANCHOR_MIN_RMS) return null;
  // varA、varB 均为正，乘积的平方根必为正有限值
  const denom = Math.sqrt(varA * varB);
  return { score: dot / denom, rmsB };
}

/**
 * 在限定帧偏移范围内对锚点做归一化互相关，返回唯一对齐结果。
 *
 * @param baseline 基线（原始）文件的锚点声道 PCM
 * @param rework 返工文件同一声道 PCM
 * @param anchor 锚点参数
 * @returns 成功对齐结果；静音/能量不足或参数非法返回错误（由调用方保留旧对照）
 */
export function alignByAnchor(
  baseline: Float32Array,
  rework: Float32Array,
  anchor: AnchorParams
): AlignmentResult | AnchorError {
  const { anchorStartFrame: start, anchorLengthFrames: length, maxOffsetFrames: maxOffset, channel } =
    anchor;

  if (!isNonNegativeInt(start)) {
    return paramError('ANCHOR_OUT_OF_RANGE', '锚点起始帧必须为非负整数');
  }
  if (!isPositiveInt(length)) {
    return paramError('ANCHOR_TOO_SHORT', '锚点长度必须为正整数');
  }
  if (!isNonNegativeInt(maxOffset)) {
    return paramError('INVALID_MAX_OFFSET', '限定帧偏移必须为非负整数');
  }
  if (!isNonNegativeInt(channel)) {
    return paramError('CHANNEL_MISMATCH', '声道序号必须为非负整数');
  }
  if (start + length > baseline.length) {
    return paramError(
      'ANCHOR_OUT_OF_RANGE',
      `锚点区间 [${start}, ${start + length - 1}] 超出基线文件帧数 ${baseline.length}`
    );
  }

  // 锚点自身必须是有效声音：静音锚点不得强行对齐
  const anchorRms = windowRms(baseline, start, length);
  if (anchorRms < ANCHOR_MIN_RMS) {
    return {
      kind: ANCHOR_LOW_ENERGY,
      message:
        '锚点能量不足（RMS 低于有效声音阈值），可能选中了静音段，不能据此对齐'
    };
  }

  // 候选窗口 [start+d, start+d+length) 必须完整落在返工 PCM 内
  const minD = Math.max(-maxOffset, -start);
  const maxD = Math.min(maxOffset, rework.length - start - length);

  let best: { d: number; score: number } | null = null;
  for (let d = minD; d <= maxD; d++) {
    const corr = normalizedCorrelation(baseline, start, rework, start + d, length);
    if (corr === null) continue; // 该候选窗口能量不足/零方差：跳过，不参与裁决
    // 裁决顺序：最高相关度 → 最小绝对偏移 → 偏移符号（平局时负偏移优先）
    if (best === null || betterCandidate(corr.score, d, best.score, best.d)) {
      best = { d, score: corr.score };
    }
  }

  if (best === null) {
    return {
      kind: ANCHOR_LOW_ENERGY,
      message:
        '限定偏移范围内找不到能量充足且可归一化的匹配窗口，不能据此对齐'
    };
  }

  return {
    offsetFrames: best.d,
    score: best.score,
    comparedFrames: length,
    anchorRms
  };
}

/**
 * 候选 (score, d) 是否优于当前最佳 (bestScore, bestD)。
 * 唯一裁决顺序：相关度更高；相关度相同则绝对偏移更小；
 * 仍相同（即 d = ±|d| 且 |d| > 0）则负偏移优先。
 */
export function betterCandidate(
  score: number,
  d: number,
  bestScore: number,
  bestD: number
): boolean {
  const eps = 1e-12;
  if (score > bestScore + eps) return true;
  if (Math.abs(score - bestScore) <= eps) {
    if (Math.abs(d) < Math.abs(bestD)) return true;
    if (Math.abs(d) === Math.abs(bestD) && d < bestD) return true;
  }
  return false;
}

/** 对齐错误的中文展示文案 */
export function alignmentErrorMessage(err: AnchorError): string {
  return err.message;
}

/** 锚点输入（页面对照面板的文本框） */
export interface RawAnchorInput {
  /** 锚点起点（秒，基线文件时间轴） */
  startSeconds: string;
  /** 锚点长度（秒） */
  lengthSeconds: string;
  /** 限定帧偏移范围（帧） */
  maxOffsetFrames: string;
  /** 对齐声道序号（0 起） */
  channel: string;
}

/** 锚点输入非法时的就地提示 */
export const INVALID_ANCHOR_NOTICE =
  '锚点参数非法：起点需为不小于 0 的数字、长度必须大于 0 秒，限定帧偏移与声道均为非负整数';

/**
 * 解析锚点输入为帧坐标参数。
 * 空、非数字、起点为负、长度不大于 0、帧偏移/声道非非负整数 → null，
 * 由调用方就地提示并保留上一次已确认的对照。
 * 锚点是否落在文件内、该声道是否存在留给 alignByAnchor / 页面校验。
 */
export function parseAnchorInput(
  raw: RawAnchorInput,
  sampleRate: number,
  channelCount: number
): AnchorParams | null {
  const s = raw.startSeconds.trim();
  const len = raw.lengthSeconds.trim();
  const off = raw.maxOffsetFrames.trim();
  const ch = raw.channel.trim();
  if (s === '' || len === '' || off === '' || ch === '') return null;

  const startSeconds = Number(s);
  const lengthSeconds = Number(len);
  const maxOffsetFrames = Number(off);
  const channel = Number(ch);

  if (!Number.isFinite(startSeconds) || startSeconds < 0) return null;
  if (!Number.isFinite(lengthSeconds) || lengthSeconds <= 0) return null;
  if (!isNonNegativeInt(maxOffsetFrames)) return null;
  if (!isNonNegativeInt(channel)) return null;
  if (channel >= channelCount) return null;

  const anchorStartFrame = Math.round(startSeconds * sampleRate);
  const anchorLengthFrames = Math.max(1, Math.round(lengthSeconds * sampleRate));
  return { anchorStartFrame, anchorLengthFrames, maxOffsetFrames, channel };
}
