/**
 * 候选规则比较（纯函数）。
 *
 * 质检规则调整前，用候选规则（threshold / min_run_frames / max_merge_gap）
 * 在已解码 PCM 上重新扫描，与基线（0.999 / 3 帧 / 2 帧）逐声道比较：
 * - 候选扫描直接复用基线结果里的解码 PCM 引用，不重复读取或解码文件；
 * - 两套合并后区间在原始帧坐标上切成最大连续差异片段，
 *   标记 BASELINE_ONLY（新规则将漏掉）、CANDIDATE_ONLY（新规则新增）或 BOTH；
 * - 只有成员集合相同且帧相邻的片段才合并；
 * - 毫秒/秒字段仅用于展示与定位，不参与任何边界裁决。
 */

import { buildScanResultWithRule, type ScanRule } from './scanner';
import { frameToEndSeconds, frameToStartSeconds, secondsToMs } from './time';
import type { ClipSegment, ScanResult } from './types';

/** 差异片段的成员集合标记 */
export type DiffMembership = 'BASELINE_ONLY' | 'CANDIDATE_ONLY' | 'BOTH';

export const DIFF_MEMBERSHIP_LABELS: Record<DiffMembership, string> = {
  BASELINE_ONLY: '仅基线（新规则漏掉）',
  CANDIDATE_ONLY: '仅候选（新规则新增）',
  BOTH: '两者共有'
};

export interface DiffSegment {
  /** 首帧索引（包含），边界裁决只使用帧坐标 */
  startFrame: number;
  /** 末帧索引（包含） */
  endFrame: number;
  membership: DiffMembership;
  /** 以下时间字段仅用于展示与定位试听 */
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface ChannelDiff {
  /** 声道序号，0 起 */
  channel: number;
  segments: DiffSegment[];
  baselineOnlyCount: number;
  candidateOnlyCount: number;
  bothCount: number;
}

/** 一次完整的候选规则比较结果：页面状态、列表与 Canvas 共用同一对象 */
export interface RuleComparison {
  /** 本次比较使用的候选规则 */
  rule: ScanRule;
  /** 候选规则扫描结果（复用已解码 PCM） */
  candidate: ScanResult;
  /** 逐声道差异片段 */
  channels: ChannelDiff[];
  /** 各声道合计：新规则将漏掉的片段数 */
  baselineOnlyCount: number;
  /** 各声道合计：新规则新增的片段数 */
  candidateOnlyCount: number;
  /** 各声道合计：两套规则共有的片段数 */
  bothCount: number;
  /** 是否存在差异（任一 BASELINE_ONLY / CANDIDATE_ONLY 片段） */
  hasDifference: boolean;
}

/** 候选规则输入非法时的就地提示 */
export const INVALID_RULE_NOTICE =
  '候选规则非法：阈值需满足 0 < 值 ≤ 1，最短连续帧为正整数，合并间隔为非负整数';

/**
 * 解析候选规则输入。
 * 任一字段非法（空、非数字、阈值不在 (0,1]、帧数非正整数、间隔非非负整数）
 * 返回 null：调用方保持上一次有效比较不变并就地提示。
 */
export function parseCandidateRule(raw: {
  threshold: string;
  minRunFrames: string;
  maxMergeGap: string;
}): ScanRule | null {
  const t = raw.threshold.trim();
  const r = raw.minRunFrames.trim();
  const g = raw.maxMergeGap.trim();
  if (t === '' || r === '' || g === '') return null;

  const threshold = Number(t);
  const minRunFrames = Number(r);
  const maxMergeGap = Number(g);

  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    return null;
  }
  if (!Number.isInteger(minRunFrames) || minRunFrames < 1) return null;
  if (!Number.isInteger(maxMergeGap) || maxMergeGap < 0) return null;
  return { threshold, minRunFrames, maxMergeGap };
}

/**
 * 把两套合并后区间切成最大连续差异片段（单声道）。
 *
 * 事件扫描在原始帧坐标上进行：每段产生 +1/-1 两个事件，
 * 同一帧的事件全部应用后再判定成员集合；
 * 成员集合不变则片段延续（即“成员集合相同且帧相邻才合并”），
 * 覆盖空隙会闭合当前片段，相同标记的片段不会跨空隙合并。
 */
export function diffChannelSegments(
  baseline: ClipSegment[],
  candidate: ClipSegment[],
  sampleRate: number,
  channel: number
): ChannelDiff {
  const events: Array<{ frame: number; deltaB: number; deltaC: number }> = [];
  for (const seg of baseline) {
    events.push({ frame: seg.startFrame, deltaB: 1, deltaC: 0 });
    events.push({ frame: seg.endFrame + 1, deltaB: -1, deltaC: 0 });
  }
  for (const seg of candidate) {
    events.push({ frame: seg.startFrame, deltaB: 0, deltaC: 1 });
    events.push({ frame: seg.endFrame + 1, deltaB: 0, deltaC: -1 });
  }
  events.sort((a, b) => a.frame - b.frame);

  const segments: DiffSegment[] = [];
  let depthB = 0;
  let depthC = 0;
  let openStart = -1;
  let openKind: DiffMembership | null = null;

  const closeSegment = (endFrame: number, kind: DiffMembership) => {
    const startSeconds = frameToStartSeconds(openStart, sampleRate);
    const endSeconds = frameToEndSeconds(endFrame, sampleRate);
    const durationSeconds = endSeconds - startSeconds;
    segments.push({
      startFrame: openStart,
      endFrame,
      membership: kind,
      startSeconds,
      endSeconds,
      durationSeconds,
      startMs: secondsToMs(startSeconds),
      endMs: secondsToMs(endSeconds),
      durationMs: secondsToMs(durationSeconds)
    });
  };

  let i = 0;
  while (i < events.length) {
    const frame = events[i]!.frame;
    // 同一帧的全部事件一起应用，再判定新的成员集合
    let j = i + 1;
    while (j < events.length && events[j]!.frame === frame) j++;
    for (let k = i; k < j; k++) {
      depthB += events[k]!.deltaB;
      depthC += events[k]!.deltaC;
    }
    const inB = depthB > 0;
    const inC = depthC > 0;
    const nextKind: DiffMembership | null = inB
      ? inC
        ? 'BOTH'
        : 'BASELINE_ONLY'
      : inC
        ? 'CANDIDATE_ONLY'
        : null;

    if (openKind !== null && nextKind !== openKind) {
      // 成员集合变化（或进入覆盖空隙）：闭合当前片段，末帧为事件帧前一帧
      closeSegment(frame - 1, openKind);
      openKind = null;
    }
    if (nextKind !== null && openKind === null) {
      openStart = frame;
      openKind = nextKind;
    }
    i = j;
  }

  let baselineOnlyCount = 0;
  let candidateOnlyCount = 0;
  let bothCount = 0;
  for (const seg of segments) {
    if (seg.membership === 'BASELINE_ONLY') baselineOnlyCount++;
    else if (seg.membership === 'CANDIDATE_ONLY') candidateOnlyCount++;
    else bothCount++;
  }

  return {
    channel,
    segments,
    baselineOnlyCount,
    candidateOnlyCount,
    bothCount
  };
}

/**
 * 用候选规则在已解码 PCM 上重新扫描并逐声道比较。
 * baseline.channelData 为解码缓冲引用，此处直接复用，
 * 不重复读取或解码文件。
 */
export function buildComparison(
  baseline: ScanResult,
  rule: ScanRule
): RuleComparison {
  const candidate = buildScanResultWithRule(
    baseline.fileName,
    baseline.channelData,
    baseline.sampleRate,
    rule
  );
  const channels = baseline.channels.map((ch) =>
    diffChannelSegments(
      ch.segments,
      candidate.channels[ch.channel]!.segments,
      baseline.sampleRate,
      ch.channel
    )
  );

  let baselineOnlyCount = 0;
  let candidateOnlyCount = 0;
  let bothCount = 0;
  for (const diff of channels) {
    baselineOnlyCount += diff.baselineOnlyCount;
    candidateOnlyCount += diff.candidateOnlyCount;
    bothCount += diff.bothCount;
  }

  return {
    rule,
    candidate,
    channels,
    baselineOnlyCount,
    candidateOnlyCount,
    bothCount,
    hasDifference: baselineOnlyCount + candidateOnlyCount > 0
  };
}
