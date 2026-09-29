/**
 * 削波扫描器（纯函数）。
 *
 * 基线判定规则（现行放行标准，保持不变）：
 * 1. 解码后的归一化 PCM 中，|sample| >= 0.999 即“削波帧”。
 * 2. 连续至少 3 帧才形成削波段。
 * 3. 相邻段间隔 <= 2 帧必须合并；间隔 >= 3 帧不得合并。
 *
 * 同一套扫描逻辑也接受候选规则（ScanRule），用于在已解码 PCM 上
 * 试算新阈值/游程/合并间隔，与基线结果做差异比较。
 */

import type { ChannelScan, ClipSegment, ScanResult } from './types';
import {
  frameToEndSeconds,
  frameToStartSeconds,
  secondsToMs
} from './time';

/** 削波阈值：绝对值大于等于该值 */
export const CLIP_THRESHOLD = 0.999;
/** 成段所需最少连续帧数 */
export const MIN_RUN_FRAMES = 3;
/** 间隔不超过该帧数的相邻段必须合并 */
export const MAX_MERGE_GAP = 2;

/** 一套完整的扫描规则：阈值 + 最短游程 + 合并间隔 */
export interface ScanRule {
  /** 削波阈值（0 < 值 <= 1），绝对值大于等于该值判定为削波帧 */
  threshold: number;
  /** 成段所需最少连续帧数（正整数） */
  minRunFrames: number;
  /** 间隔不超过该帧数的相邻段必须合并（非负整数） */
  maxMergeGap: number;
}

/** 现行基线规则：0.999 / 连续 3 帧 / 间隔 2 帧 */
export const BASELINE_RULE: ScanRule = {
  threshold: CLIP_THRESHOLD,
  minRunFrames: MIN_RUN_FRAMES,
  maxMergeGap: MAX_MERGE_GAP
};

export function isClipSample(sample: number): boolean {
  return Math.abs(sample) >= CLIP_THRESHOLD;
}

/** 校验候选规则取值范围；非法规则抛出 RangeError */
export function assertValidRule(rule: ScanRule): void {
  if (
    !Number.isFinite(rule.threshold) ||
    rule.threshold <= 0 ||
    rule.threshold > 1
  ) {
    throw new RangeError(`非法削波阈值: ${String(rule.threshold)}`);
  }
  if (!Number.isInteger(rule.minRunFrames) || rule.minRunFrames < 1) {
    throw new RangeError(`非法最短连续帧数: ${String(rule.minRunFrames)}`);
  }
  if (!Number.isInteger(rule.maxMergeGap) || rule.maxMergeGap < 0) {
    throw new RangeError(`非法合并间隔: ${String(rule.maxMergeGap)}`);
  }
}

/**
 * 按指定规则扫描单声道 PCM，返回合并后的削波段（按时间升序）。
 * 所有判定均在原始帧坐标上进行，毫秒仅用于展示。
 */
export function scanChannelWithRule(
  data: Float32Array,
  sampleRate: number,
  channel: number,
  rule: ScanRule
): ChannelScan {
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) {
    throw new RangeError(`非法采样率: ${String(sampleRate)}`);
  }
  assertValidRule(rule);

  // 第一步：找出所有长度 >= minRunFrames 的连续帧游程
  const runs: Array<[number, number]> = [];
  let runStart = -1;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]!) >= rule.threshold) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - runStart >= rule.minRunFrames) runs.push([runStart, i - 1]);
      runStart = -1;
    }
  }
  if (runStart >= 0 && data.length - runStart >= rule.minRunFrames) {
    runs.push([runStart, data.length - 1]);
  }

  // 第二步：间隔 <= maxMergeGap 帧的相邻段必须合并
  // （间隔 = 下一段首帧 - 上一段末帧 - 1）
  const merged: Array<[number, number]> = [];
  for (const [start, end] of runs) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start - last[1]! - 1 <= rule.maxMergeGap) {
      last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }

  const segments: ClipSegment[] = merged.map(([startFrame, endFrame]) => {
    const startSeconds = frameToStartSeconds(startFrame, sampleRate);
    const endSeconds = frameToEndSeconds(endFrame, sampleRate);
    const durationSeconds = endSeconds - startSeconds;
    return {
      startFrame,
      endFrame,
      startSeconds,
      endSeconds,
      durationSeconds,
      startMs: secondsToMs(startSeconds),
      endMs: secondsToMs(endSeconds),
      durationMs: secondsToMs(durationSeconds)
    };
  });

  const totalClipSeconds = segments.reduce(
    (sum, seg) => sum + seg.durationSeconds,
    0
  );

  return {
    channel,
    segments,
    totalClipSeconds,
    totalClipMs: secondsToMs(totalClipSeconds),
    frameCount: data.length,
    sampleRate
  };
}

/**
 * 按基线规则扫描单声道 PCM（现行放行标准）。
 */
export function scanChannel(
  data: Float32Array,
  sampleRate: number,
  channel: number
): ChannelScan {
  return scanChannelWithRule(data, sampleRate, channel, BASELINE_RULE);
}

/**
 * 按指定规则汇总所有声道扫描结果。
 * 总削波时长按各声道区间时长累加，同一时刻多声道削波分别计入。
 */
export function buildScanResultWithRule(
  fileName: string,
  channelData: Float32Array[],
  sampleRate: number,
  rule: ScanRule
): ScanResult {
  const channels = channelData.map((data, index) =>
    scanChannelWithRule(data, sampleRate, index, rule)
  );
  const totalClipSeconds = channels.reduce(
    (sum, ch) => sum + ch.totalClipSeconds,
    0
  );

  let firstClip: { channel: number; segment: ClipSegment } | null = null;
  for (const ch of channels) {
    const seg = ch.segments[0];
    if (
      seg !== undefined &&
      (firstClip === null || seg.startFrame < firstClip.segment.startFrame)
    ) {
      firstClip = { channel: ch.channel, segment: seg };
    }
  }

  const frameCount = channelData.reduce((max, d) => Math.max(max, d.length), 0);

  return {
    fileName,
    sampleRate,
    channels,
    totalClipSeconds,
    totalClipMs: secondsToMs(totalClipSeconds),
    hasClip: firstClip !== null,
    firstClip,
    channelData,
    durationSeconds: frameCount / sampleRate
  };
}

/**
 * 按基线规则汇总所有声道扫描结果（现行放行标准）。
 */
export function buildScanResult(
  fileName: string,
  channelData: Float32Array[],
  sampleRate: number
): ScanResult {
  return buildScanResultWithRule(fileName, channelData, sampleRate, BASELINE_RULE);
}
