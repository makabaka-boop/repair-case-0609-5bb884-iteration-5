/**
 * 返工文件对照（纯函数核心）。
 *
 * 质检员收到同一段录音的返工文件时，录制起点往往相差几十帧：直接按帧号
 * 比较会把整体错位误判成削波修复。本模块的裁决顺序：
 *
 * 1. 用户在基线文件上选取一段“有效声音”作为锚点（起点秒、时长秒、声道、
 *    允许搜索的最大帧偏移）；
 * 2. 在 [-maxOffset, +maxOffset] 的逐帧偏移上，对两份【已解码 PCM】计算
 *    归一化互相关（NCC，局部均值/方差按实际重叠样本归一化，与整体音量无关）；
 * 3. 唯一对齐结果按【最高相关度 → 最小绝对偏移 → 偏移为正】依次裁决；
 * 4. 锚点静音或能量不足（基线侧 RMS 过低）直接判失败，不得强行对齐。
 *
 * 偏移约定（帧坐标）：
 *   rework[f + offsetFrames] === baseline[f]
 * 即 offsetFrames > 0 表示返工文件的同一段内容比基线晚开始 offsetFrames 帧。
 *
 * 对齐完成后，两套削波扫描区间只在【真实重叠的原始帧】范围内比较：
 * 重叠区内逐帧判定 已修复(FIXED) / 新增(NEW) / 共有(BOTH)；
 * 任一文件未覆盖的区域标记 BASELINE_ONLY / REWORK_ONLY（不可比较），
 * 不计入任何一侧独有。差异表、双波形着色与定位试听共用同一 ReworkComparison
 * 对象与同一偏移；试听时分别映射回各自文件坐标。
 */

import {
  BASELINE_RULE,
  buildScanResultWithRule,
  type ScanRule
} from './scanner';
import { frameToEndSeconds, frameToStartSeconds, secondsToMs } from './time';
import type { ClipSegment, ScanResult } from './types';

/** 锚点最少帧数：短于该长度的锚点不允许对齐（帧过少时相关度不稳定） */
export const MIN_ANCHOR_FRAMES = 16;
/**
 * 锚点最低能量（基线侧 RMS，归一化满幅为 1）：
 * 低于该值视为静音或能量不足，不得强行对齐。
 */
export const MIN_ANCHOR_RMS = 0.01;

// ---------------------------------------------------------------------------
// 锚点输入解析
// ---------------------------------------------------------------------------

/** 用户在页面填写的锚点原始输入（均为字符串） */
export interface AnchorInput {
  /** 锚点起点（基线文件时间，秒） */
  anchorStart: string;
  /** 锚点时长（秒） */
  anchorDuration: string;
  /** 锚点声道序号（0 起） */
  channel: string;
  /** 允许搜索的最大帧偏移（非负整数，搜索 [-N, +N]） */
  maxOffsetFrames: string;
}

/** 解析通过的锚点选择（数值形态；范围合法性在 findBestAlignment 内裁决） */
export interface AnchorSelection {
  anchorStartSeconds: number;
  anchorDurationSeconds: number;
  channel: number;
  maxOffsetFrames: number;
}

/** 锚点输入非法（空/非数字/范围形态错误）时的就地提示 */
export const INVALID_ANCHOR_NOTICE =
  '锚点输入非法：起点需为非负秒数，时长为大于零的秒数，声道为非负整数序号，最大帧偏移为非负整数';

/**
 * 解析锚点输入。
 * 空、非数字、起点为负、时长不大于零、声道/帧偏移非非负整数 → null，
 * 调用方就地提示并保留上一次有效对照。
 */
export function parseAnchorSelection(raw: AnchorInput): AnchorSelection | null {
  const start = raw.anchorStart.trim();
  const duration = raw.anchorDuration.trim();
  const channel = raw.channel.trim();
  const maxOffset = raw.maxOffsetFrames.trim();
  if (start === '' || duration === '' || channel === '' || maxOffset === '') {
    return null;
  }
  const anchorStartSeconds = Number(start);
  const anchorDurationSeconds = Number(duration);
  const channelIndex = Number(channel);
  const maxOffsetFrames = Number(maxOffset);
  if (!Number.isFinite(anchorStartSeconds) || anchorStartSeconds < 0) return null;
  if (!Number.isFinite(anchorDurationSeconds) || anchorDurationSeconds <= 0) {
    return null;
  }
  if (!Number.isInteger(channelIndex) || channelIndex < 0) return null;
  if (!Number.isInteger(maxOffsetFrames) || maxOffsetFrames < 0) return null;
  return {
    anchorStartSeconds,
    anchorDurationSeconds,
    channel: channelIndex,
    maxOffsetFrames
  };
}

// ---------------------------------------------------------------------------
// 能量与归一化互相关
// ---------------------------------------------------------------------------

/** 一段 PCM 的均方根能量（RMS）；长度非法返回 0 */
export function rms(data: Float32Array, start: number, length: number): number {
  if (length <= 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < length; i++) {
    const v = data[start + i]!;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / length);
}

/**
 * 归一化互相关（NCC，皮尔逊相关系数）：
 *   Σ(a−ā)(b−b̄) / sqrt(Σ(a−ā)² · Σ(b−b̄)²)
 * 均值与方差只按实际参与重叠的样本计算，因此与两份文件的整体音量/直流偏置无关。
 * 任一侧窗口零方差（常量/静音窗口）时无法归一化，返回 NaN，调用方跳过该偏移。
 */
export function normalizedCrossCorrelation(
  base: Float32Array,
  baseStart: number,
  rework: Float32Array,
  reworkStart: number,
  length: number
): number {
  if (length <= 0) return NaN;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < length; i++) {
    meanA += base[baseStart + i]!;
    meanB += rework[reworkStart + i]!;
  }
  meanA /= length;
  meanB /= length;

  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < length; i++) {
    const da = base[baseStart + i]! - meanA;
    const db = rework[reworkStart + i]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  const denom = Math.sqrt(varA * varB);
  if (denom === 0) return NaN;
  const value = cov / denom;
  // 数值误差可能略微越界，钳制到 [-1, 1]
  return value > 1 ? 1 : value < -1 ? -1 : value;
}

/** 单个候选偏移的相关度评分 */
export interface LagScore {
  /** 帧偏移 d：rework[f + d] 对应 baseline[f] */
  lag: number;
  /** NCC 相关度；NaN（零方差窗口）不参与裁决 */
  score: number;
  /** 实际参与计算的重叠帧数（此处恒为完整锚点长度） */
  overlapFrames: number;
}

/**
 * 从全部候选偏移中选出唯一结果。
 * 裁决顺序：相关度最高 → |偏移| 最小 → 偏移为正（+d 优先于 -d）。
 * 相关度按精确相等比较（同一份 PCM、同一遍历顺序下对称滞后可产生位级相同结果）。
 * 无有效候选（空数组或全部 NaN）返回 null。
 */
export function chooseBestLag(scores: LagScore[]): LagScore | null {
  let best: LagScore | null = null;
  for (const candidate of scores) {
    if (!Number.isFinite(candidate.score)) continue;
    if (best === null) {
      best = candidate;
      continue;
    }
    if (candidate.score > best.score) {
      best = candidate;
    } else if (candidate.score === best.score) {
      if (Math.abs(candidate.lag) < Math.abs(best.lag)) {
        best = candidate;
      } else if (
        Math.abs(candidate.lag) === Math.abs(best.lag) &&
        candidate.lag > best.lag
      ) {
        // 等相关度、等绝对偏移：正偏移优先（+d 胜过 -d；0 本身不与任何值同绝对值）
        best = candidate;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 对齐裁决
// ---------------------------------------------------------------------------

/** 偏移方向标记：正（返工晚于基线）/ 负（返工早于基线）/ 零 */
export type OffsetSign = '+' | '-' | '0';

export function offsetSign(offsetFrames: number): OffsetSign {
  if (offsetFrames > 0) return '+';
  if (offsetFrames < 0) return '-';
  return '0';
}

/** 对齐成功结果 */
export interface AlignedResult {
  status: 'aligned';
  /** 唯一对齐偏移 d：rework[f + d] 对应 baseline[f] */
  offsetFrames: number;
  sign: OffsetSign;
  /** 胜出偏移的 NCC 相关度（-1..1） */
  bestScore: number;
  /** 参与裁决的有效候选偏移数 */
  candidateCount: number;
  /** 锚点所在声道（0 起） */
  channel: number;
  /** 锚点在基线文件上的首帧 */
  anchorStartFrame: number;
  /** 锚点帧数 */
  anchorFrameCount: number;
  /** 锚点基线侧 RMS（展示用，>= MIN_ANCHOR_RMS 才会到达成功结果） */
  anchorRms: number;
  /** 本次搜索允许的最大帧偏移 */
  maxOffsetFrames: number;
}

/** 对齐失败原因 */
export type AlignFailureReason =
  | 'format-mismatch'
  | 'invalid-anchor'
  | 'weak-anchor'
  | 'no-overlap';

export interface AlignFailure {
  status: 'failed';
  reason: AlignFailureReason;
  /** 就地提示文案 */
  message: string;
  /** 弱锚点时携带实测 RMS（展示用） */
  anchorRms?: number;
  anchorFrameCount?: number;
}

export type AlignmentResult = AlignedResult | AlignFailure;

export interface FindAlignmentParams {
  baseline: ScanResult;
  rework: ScanResult;
  selection: AnchorSelection;
}

/**
 * 在已解码 PCM 上做锚点对齐裁决。
 * 失败一律返回带原因的结果且不产出对照（调用方保留上一次有效对照）：
 * - format-mismatch：采样率或声道数不同，无法逐帧对齐；
 * - invalid-anchor：声道越界、锚点未完整落在基线内或短于 MIN_ANCHOR_FRAMES；
 * - weak-anchor：基线侧锚点 RMS < MIN_ANCHOR_RMS（静音/能量不足），不得强行对齐；
 * - no-overlap：限定偏移范围内没有完整容纳锚点的候选，或所有候选零方差。
 */
export function findBestAlignment(params: FindAlignmentParams): AlignmentResult {
  const { baseline, rework, selection } = params;

  if (
    baseline.sampleRate !== rework.sampleRate ||
    baseline.channels.length !== rework.channels.length
  ) {
    return {
      status: 'failed',
      reason: 'format-mismatch',
      message: `两份文件规格不一致，无法逐帧对齐：基线 ${baseline.sampleRate} Hz / ${baseline.channels.length} 声道，返工 ${rework.sampleRate} Hz / ${rework.channels.length} 声道`
    };
  }

  const channel = selection.channel;
  if (channel < 0 || channel >= baseline.channels.length) {
    return {
      status: 'failed',
      reason: 'invalid-anchor',
      message: `锚点声道序号 ${channel} 超出范围（基线共 ${baseline.channels.length} 个声道，序号 0 起）`
    };
  }

  const sr = baseline.sampleRate;
  const baseData = baseline.channelData[channel]!;
  const reworkData = rework.channelData[channel]!;

  const anchorStartFrame = Math.round(selection.anchorStartSeconds * sr);
  const anchorFrameCount = Math.round(selection.anchorDurationSeconds * sr);
  if (anchorStartFrame < 0 || anchorStartFrame >= baseData.length) {
    return {
      status: 'failed',
      reason: 'invalid-anchor',
      message: '锚点起点超出基线文件范围，请在基线文件的一段有效声音上重新选取'
    };
  }
  if (anchorFrameCount < MIN_ANCHOR_FRAMES) {
    return {
      status: 'failed',
      reason: 'invalid-anchor',
      message: `锚点时长过短：至少需要 ${MIN_ANCHOR_FRAMES} 帧（约 ${(MIN_ANCHOR_FRAMES / sr).toFixed(4)} 秒），请选更长的一段有效声音`,
      anchorFrameCount
    };
  }
  const anchorEndExclusive = anchorStartFrame + anchorFrameCount;
  if (anchorEndExclusive > baseData.length) {
    return {
      status: 'failed',
      reason: 'invalid-anchor',
      message: '锚点终点超出基线文件范围，锚点必须完整落在一段有效声音内'
    };
  }

  // 静音或能量不足的锚点不得强行对齐（只以基线侧能量为准）
  const energy = rms(baseData, anchorStartFrame, anchorFrameCount);
  if (energy < MIN_ANCHOR_RMS) {
    return {
      status: 'failed',
      reason: 'weak-anchor',
      message: `锚点静音或能量不足（RMS ${energy.toFixed(5)} < ${MIN_ANCHOR_RMS}），不得强行对齐，请改选一段清晰的有效声音`,
      anchorRms: energy,
      anchorFrameCount
    };
  }

  // 在 [-maxOffset, +maxOffset] 内逐帧滑动完整锚点窗口：
  // rework[f + d] 对应 baseline[f]，窗口须完整落在返工 PCM 内。
  const scores: LagScore[] = [];
  for (let d = -selection.maxOffsetFrames; d <= selection.maxOffsetFrames; d++) {
    const reworkAnchorStart = anchorStartFrame + d;
    if (reworkAnchorStart < 0) continue;
    if (reworkAnchorStart + anchorFrameCount > reworkData.length) continue;
    scores.push({
      lag: d,
      score: normalizedCrossCorrelation(
        baseData,
        anchorStartFrame,
        reworkData,
        reworkAnchorStart,
        anchorFrameCount
      ),
      overlapFrames: anchorFrameCount
    });
  }

  const best = chooseBestLag(scores);
  if (best === null) {
    return {
      status: 'failed',
      reason: 'no-overlap',
      message:
        '限定帧偏移范围内锚点无法完整重叠（或候选窗口全部零方差），无法对齐：请扩大帧偏移范围或改选锚点',
      anchorFrameCount
    };
  }

  return {
    status: 'aligned',
    offsetFrames: best.lag,
    sign: offsetSign(best.lag),
    bestScore: best.score,
    candidateCount: scores.length,
    channel,
    anchorStartFrame,
    anchorFrameCount,
    anchorRms: energy,
    maxOffsetFrames: selection.maxOffsetFrames
  };
}

// ---------------------------------------------------------------------------
// 重叠区与差异片段
// ---------------------------------------------------------------------------

/** 返工对照差异标记（只在真实重叠的原始帧范围内裁决独有性） */
export type ReworkDiffKind =
  | 'FIXED' // 重叠区：仅基线有削波 → 返工确实修复
  | 'NEW' // 重叠区：仅返工有削波 → 返工新引入
  | 'BOTH' // 重叠区：两侧都有
  | 'BASELINE_ONLY' // 返工未覆盖，不可比较（不计基线独有）
  | 'REWORK_ONLY'; // 基线未覆盖，不可比较（不计返工独有）

export const REWORK_DIFF_KIND_LABELS: Record<ReworkDiffKind, string> = {
  FIXED: '已修复（仅基线，重叠区）',
  NEW: '新增削波（仅返工，重叠区）',
  BOTH: '两侧共有',
  BASELINE_ONLY: '基线独有区域（返工未覆盖，不可比较）',
  REWORK_ONLY: '返工独有区域（基线未覆盖，不可比较）'
};

/**
 * 对齐后的真实重叠区（全局帧坐标以基线帧号表示）：
 * rework[f + d] 对应 baseline[f]。
 * 返回全局帧 [baseStartFrame, baseEndExclusive)；无真实重叠返回 null。
 */
export function alignedOverlapFrames(
  baselineFrames: number,
  reworkFrames: number,
  offsetFrames: number
): { startFrame: number; endExclusive: number } | null {
  const startFrame = Math.max(0, -offsetFrames);
  const endExclusive = Math.min(baselineFrames, reworkFrames - offsetFrames);
  if (endExclusive <= startFrame) return null;
  return { startFrame, endExclusive };
}

/** 单条返工对照差异片段；未覆盖一侧的坐标为 null（不可比较） */
export interface ReworkDiffSegment {
  kind: ReworkDiffKind;
  /** 全局首帧（= 基线帧坐标） */
  startFrame: number;
  /** 全局末帧（含，= 基线帧坐标） */
  endFrame: number;
  baselineStartFrame: number | null;
  baselineEndFrame: number | null;
  reworkStartFrame: number | null;
  reworkEndFrame: number | null;
  // 以下展示/定位字段按各自文件坐标换算；未覆盖一侧为 null
  baselineStartMs: number | null;
  baselineEndMs: number | null;
  baselineSecondsStart: number | null;
  baselineSecondsEnd: number | null;
  reworkStartMs: number | null;
  reworkEndMs: number | null;
  reworkSecondsStart: number | null;
  reworkSecondsEnd: number | null;
}

export interface ReworkChannelDiff {
  channel: number;
  segments: ReworkDiffSegment[];
  fixedCount: number;
  newCount: number;
  bothCount: number;
  baselineOnlyCount: number;
  reworkOnlyCount: number;
  /** 不可比较帧数（任一文件未覆盖） */
  incomparableFrames: number;
}

interface SpanEvent {
  frame: number;
  deltaB: number;
  deltaR: number;
  deltaO: number;
  /** 进入/离开基线文件物理覆盖（全局坐标 [0, baseFrames)） */
  deltaCoverB: number;
  /** 进入/离开返工文件物理覆盖（全局帧 f 对应返工帧 f+offset） */
  deltaCoverR: number;
}

/**
 * 全局帧 f 上的差异标记：
 * - 只有两份文件【物理覆盖交集】（重叠区）内的帧才能判 FIXED/NEW/BOTH；
 *   偏移可能让全局帧虽在声明重叠区内却越过某一侧文件末端，
 *   此时该侧坐标不存在，必须归入不可比较（BASELINE_ONLY/REWORK_ONLY）。
 * - 任一文件未覆盖：不可比较，不能算作任何一侧独有。
 */
function kindAt(
  inB: boolean,
  inR: boolean,
  inOverlap: boolean,
  coveredB: boolean,
  coveredR: boolean
): ReworkDiffKind | null {
  if (!inB && !inR) return null;
  if (inOverlap && coveredB && coveredR) {
    if (inB && inR) return 'BOTH';
    if (inB) return 'FIXED';
    return 'NEW';
  }
  return inB ? 'BASELINE_ONLY' : 'REWORK_ONLY';
}

/**
 * 单声道差异切片（全局/基线帧坐标上的事件扫描）。
 * 基线段直接落在全局坐标；返工段 [s,e] 平移 -offsetFrames 后进入全局坐标。
 * 成员集合（含“是否在重叠区内”）不变且帧相邻才并入同一片段；
 * 覆盖空隙闭合当前片段，相同标记不跨空隙合并。
 */
export function diffChannelRework(params: {
  channel: number;
  baseline: ClipSegment[];
  rework: ClipSegment[];
  sampleRate: number;
  /** 基线文件该声道帧数 */
  baselineFrames: number;
  /** 返工文件该声道帧数 */
  reworkFrames: number;
  overlapStartFrame: number;
  overlapEndExclusive: number;
  offsetFrames: number;
}): ReworkChannelDiff {
  const {
    channel,
    baseline,
    rework,
    sampleRate: sr,
    baselineFrames,
    reworkFrames,
    overlapStartFrame,
    overlapEndExclusive,
    offsetFrames
  } = params;

  const events: SpanEvent[] = [];
  const ev = (
    frame: number,
    patch: Partial<Omit<SpanEvent, 'frame'>>
  ): void => {
    events.push({
      frame,
      deltaB: 0,
      deltaR: 0,
      deltaO: 0,
      deltaCoverB: 0,
      deltaCoverR: 0,
      ...patch
    });
  };
  for (const seg of baseline) {
    ev(seg.startFrame, { deltaB: 1 });
    ev(seg.endFrame + 1, { deltaB: -1 });
  }
  for (const seg of rework) {
    // 返工本地帧 r → 全局帧 r - d
    ev(seg.startFrame - offsetFrames, { deltaR: 1 });
    ev(seg.endFrame + 1 - offsetFrames, { deltaR: -1 });
  }
  // 重叠区边界本身改变成员集合（重叠区内外“独有”语义不同）
  ev(overlapStartFrame, { deltaO: 1 });
  ev(overlapEndExclusive, { deltaO: -1 });
  // 物理覆盖结束边界（进入事件由帧 0 的初始深度表达，避免负帧事件污染状态）：
  // 基线覆盖 [0, baselineFrames)；返工覆盖 [-d, reworkFrames-d)
  ev(baselineFrames, { deltaCoverB: -1 });
  ev(reworkFrames - offsetFrames, { deltaCoverR: -1 });
  // 返工覆盖区间为全局 [-d, reworkFrames-d)：起点在帧 0 之后（d<0）时补进入事件；
  // 起点 <= 0（d>=0）时帧 0 已在覆盖内，由初始深度表达（负帧事件不入扫描）。
  if (offsetFrames < 0) ev(-offsetFrames, { deltaCoverR: 1 });
  events.sort((a, b) => a.frame - b.frame);

  const segments: ReworkDiffSegment[] = [];
  // 帧 0 起的初始覆盖深度：全局帧 0 在基线上恒覆盖；
  // 返工覆盖 [-d, ...)，帧 0 被覆盖当且仅当 -d <= 0（即 d >= 0）。
  let depthB = 0;
  let depthR = 0;
  let depthO = 0;
  let coverB = 1;
  let coverR = offsetFrames >= 0 ? 1 : 0;
  let openStart = -1;
  let openKind: ReworkDiffKind | null = null;

  const pushSegment = (endFrame: number, kind: ReworkDiffKind) => {
    // 坐标是否存在取决于该侧文件是否物理覆盖该片段（与削波集合正交）。
    // 闭合发生在边界事件应用之后，此时覆盖深度已翻转，不能用当前深度判定；
    // 片段在扫描中不会跨越覆盖边界（覆盖边界本身就会改变 kind），
    // 故直接按片段的全局帧区间与覆盖区间求交即可。
    const coverBStart = 0;
    const coverBEnd = baselineFrames - 1;
    const coverRStart = -offsetFrames;
    const coverREnd = reworkFrames - offsetFrames - 1;
    const baselineCovered = openStart <= coverBEnd && endFrame >= coverBStart;
    const reworkCovered = openStart <= coverREnd && endFrame >= coverRStart;
    const bStart = baselineCovered ? openStart : null;
    const bEnd = baselineCovered ? endFrame : null;
    const rStart = reworkCovered ? openStart + offsetFrames : null;
    const rEnd = reworkCovered ? endFrame + offsetFrames : null;
    segments.push({
      kind,
      startFrame: openStart,
      endFrame,
      baselineStartFrame: bStart,
      baselineEndFrame: bEnd,
      reworkStartFrame: rStart,
      reworkEndFrame: rEnd,
      baselineSecondsStart: bStart !== null ? frameToStartSeconds(bStart, sr) : null,
      baselineSecondsEnd: bEnd !== null ? frameToEndSeconds(bEnd, sr) : null,
      baselineStartMs: bStart !== null ? secondsToMs(frameToStartSeconds(bStart, sr)) : null,
      baselineEndMs: bEnd !== null ? secondsToMs(frameToEndSeconds(bEnd, sr)) : null,
      reworkSecondsStart: rStart !== null ? frameToStartSeconds(rStart, sr) : null,
      reworkSecondsEnd: rEnd !== null ? frameToEndSeconds(rEnd, sr) : null,
      reworkStartMs: rStart !== null ? secondsToMs(frameToStartSeconds(rStart, sr)) : null,
      reworkEndMs: rEnd !== null ? secondsToMs(frameToEndSeconds(rEnd, sr)) : null
    });
  };

  let i = 0;
  while (i < events.length) {
    const frame = events[i]!.frame;
    let j = i + 1;
    while (j < events.length && events[j]!.frame === frame) j++;
    for (let k = i; k < j; k++) {
      depthB += events[k]!.deltaB;
      depthR += events[k]!.deltaR;
      depthO += events[k]!.deltaO;
      coverB += events[k]!.deltaCoverB;
      coverR += events[k]!.deltaCoverR;
    }
    const nextKind = kindAt(
      depthB > 0,
      depthR > 0,
      depthO > 0,
      coverB > 0,
      coverR > 0
    );
    if (openKind !== null && nextKind !== openKind) {
      pushSegment(frame - 1, openKind);
      openKind = null;
    }
    if (nextKind !== null && openKind === null) {
      openStart = frame;
      openKind = nextKind;
    }
    i = j;
  }

  let fixedCount = 0;
  let newCount = 0;
  let bothCount = 0;
  let baselineOnlyCount = 0;
  let reworkOnlyCount = 0;
  let incomparableFrames = 0;
  for (const seg of segments) {
    const frames = seg.endFrame - seg.startFrame + 1;
    switch (seg.kind) {
      case 'FIXED':
        fixedCount++;
        break;
      case 'NEW':
        newCount++;
        break;
      case 'BOTH':
        bothCount++;
        break;
      case 'BASELINE_ONLY':
        baselineOnlyCount++;
        incomparableFrames += frames;
        break;
      case 'REWORK_ONLY':
        reworkOnlyCount++;
        incomparableFrames += frames;
    }
  }

  return {
    channel,
    segments,
    fixedCount,
    newCount,
    bothCount,
    baselineOnlyCount,
    reworkOnlyCount,
    incomparableFrames
  };
}

// ---------------------------------------------------------------------------
// 完整对照结果（差异表、双波形、定位试听共用同一对象）
// ---------------------------------------------------------------------------

export interface ReworkComparison {
  baseline: ScanResult;
  rework: ScanResult;
  /** 两份文件共用的扫描规则（现行基线规则） */
  rule: ScanRule;
  alignment: AlignedResult;
  /** 真实重叠区（全局/基线帧坐标，含首不含末） */
  overlapStartFrame: number;
  overlapEndExclusive: number;
  overlapFrameCount: number;
  channels: ReworkChannelDiff[];
  fixedCount: number;
  newCount: number;
  bothCount: number;
  baselineOnlyCount: number;
  reworkOnlyCount: number;
  /** 不可比较帧合计（未覆盖区域） */
  incomparableFrames: number;
  /** 是否存在真实质量变化：重叠区内的已修复或新增 */
  hasRealDifference: boolean;
}

/**
 * 用同一套基线规则扫描返工 PCM，并按对齐偏移只在真实重叠帧范围内
 * 与基线扫描结果逐声道比较。返工扫描复用其已解码 PCM 引用，不重新解码。
 */
export function buildReworkComparison(
  baseline: ScanResult,
  rework: ScanResult,
  alignment: AlignedResult
): ReworkComparison {
  if (
    baseline.sampleRate !== rework.sampleRate ||
    baseline.channels.length !== rework.channels.length
  ) {
    throw new RangeError('两份文件采样率/声道数不一致，无法建立返工对照');
  }
  const overlap = alignedOverlapFrames(
    baseline.channelData.reduce((max, d) => Math.max(max, d.length), 0),
    rework.channelData.reduce((max, d) => Math.max(max, d.length), 0),
    alignment.offsetFrames
  );
  if (overlap === null) {
    throw new RangeError('对齐偏移下两份文件没有真实重叠帧，无法比较');
  }

  const reworkScan = buildScanResultWithRule(
    rework.fileName,
    rework.channelData,
    rework.sampleRate,
    BASELINE_RULE
  );

  const channels = baseline.channels.map((ch) =>
    diffChannelRework({
      channel: ch.channel,
      baseline: ch.segments,
      rework: reworkScan.channels[ch.channel]!.segments,
      sampleRate: baseline.sampleRate,
      baselineFrames: ch.frameCount,
      reworkFrames: reworkScan.channels[ch.channel]!.frameCount,
      overlapStartFrame: overlap.startFrame,
      overlapEndExclusive: overlap.endExclusive,
      offsetFrames: alignment.offsetFrames
    })
  );

  let fixedCount = 0;
  let newCount = 0;
  let bothCount = 0;
  let baselineOnlyCount = 0;
  let reworkOnlyCount = 0;
  let incomparableFrames = 0;
  for (const diff of channels) {
    fixedCount += diff.fixedCount;
    newCount += diff.newCount;
    bothCount += diff.bothCount;
    baselineOnlyCount += diff.baselineOnlyCount;
    reworkOnlyCount += diff.reworkOnlyCount;
    incomparableFrames += diff.incomparableFrames;
  }

  return {
    baseline,
    rework,
    rule: BASELINE_RULE,
    alignment,
    overlapStartFrame: overlap.startFrame,
    overlapEndExclusive: overlap.endExclusive,
    overlapFrameCount: overlap.endExclusive - overlap.startFrame,
    channels,
    fixedCount,
    newCount,
    bothCount,
    baselineOnlyCount,
    reworkOnlyCount,
    incomparableFrames,
    hasRealDifference: fixedCount + newCount > 0
  };
}

// ---------------------------------------------------------------------------
// 双波形着色与试听坐标映射（共用同一偏移与片段数组）
// ---------------------------------------------------------------------------

/** 波形上的着色标记：双波形与差异表共用同一 ReworkDiffSegment 数组 */
export interface WaveMark {
  startSeconds: number;
  endSeconds: number;
  kind: ReworkDiffKind;
}

/** 取出片段在基线文件坐标上的着色标记；基线未覆盖（不可比较）返回 null */
export function baselineWaveMark(seg: ReworkDiffSegment): WaveMark | null {
  if (seg.baselineSecondsStart === null || seg.baselineSecondsEnd === null) {
    return null;
  }
  return {
    startSeconds: seg.baselineSecondsStart,
    endSeconds: seg.baselineSecondsEnd,
    kind: seg.kind
  };
}

/** 取出片段在返工文件坐标上的着色标记；返工未覆盖返回 null */
export function reworkWaveMark(seg: ReworkDiffSegment): WaveMark | null {
  if (seg.reworkSecondsStart === null || seg.reworkSecondsEnd === null) {
    return null;
  }
  return {
    startSeconds: seg.reworkSecondsStart,
    endSeconds: seg.reworkSecondsEnd,
    kind: seg.kind
  };
}

export function baselineWaveMarks(segments: ReworkDiffSegment[]): WaveMark[] {
  return segments
    .map(baselineWaveMark)
    .filter((m): m is WaveMark => m !== null);
}

export function reworkWaveMarks(segments: ReworkDiffSegment[]): WaveMark[] {
  return segments
    .map(reworkWaveMark)
    .filter((m): m is WaveMark => m !== null);
}

/**
 * 试听坐标映射：rework[f + d] === baseline[f]。
 * 定位试听时同一段内容分别映射回各自文件坐标，两个播放器各跳各的时间。
 */
export function baselineSecondsToRework(
  baselineSeconds: number,
  offsetFrames: number,
  sampleRate: number
): number {
  return baselineSeconds + offsetFrames / sampleRate;
}

export function reworkSecondsToBaseline(
  reworkSeconds: number,
  offsetFrames: number,
  sampleRate: number
): number {
  return reworkSeconds - offsetFrames / sampleRate;
}

/** 基线视窗（秒）映射为返工文件视窗，供双波形按同一偏移并排对齐 */
export function mapViewRangeToRework(
  range: { startSeconds: number; endSeconds: number },
  offsetFrames: number,
  sampleRate: number
): { startSeconds: number; endSeconds: number } {
  const shift = offsetFrames / sampleRate;
  return {
    startSeconds: range.startSeconds + shift,
    endSeconds: range.endSeconds + shift
  };
}
