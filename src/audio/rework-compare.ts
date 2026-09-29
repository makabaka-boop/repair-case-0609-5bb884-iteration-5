/**
 * 返工文件对照（纯函数）。
 *
 * 在单文件基线扫描之外，再载入同一录音的返工文件：先用锚点 NCC
 * （见 alignment.ts）求出唯一帧偏移，再把两套削波区间放到
 * **真实重叠的原始帧范围**内逐帧裁决。
 *
 * 坐标约定：
 * - 全部边界裁决只用原始帧坐标，毫秒仅用于展示；
 * - offset = 返工帧 − 基线帧，即 reworkFrame = baselineFrame + offset；
 * - 重叠区指两份扫描实际覆盖到的帧（按各自 PCM 帧数），
 *   未覆盖区域一律 INCOMPARABLE，绝不算任何一方“独有”的质量差异；
 * - 差异表、双波形着色与定位试听共用同一 ReworkDiffSegment 数组，
 *   每个片段同时带两套坐标，试听时分别映射回各自文件。
 */

import type { ClipSegment, ScanResult } from './types';
import type { AlignmentResult, AnchorParams } from './alignment';
import { frameToEndSeconds, frameToStartSeconds, secondsToMs } from './time';

/** 返工对照差异片段的成员标记 */
export type ReworkMembership =
  | 'BASELINE_ONLY' // 重叠区内：基线有削波、返工已无（确实被修复）
  | 'REWORK_ONLY' // 重叠区内：基线无削波、返工新引入（返工新增）
  | 'BOTH' // 重叠区内：两边都削波（仍未修复）
  | 'BASELINE_UNCOMPARED' // 基线段落在重叠区外，不可比较
  | 'REWORK_UNCOMPARED'; // 返工段落在重叠区外，不可比较

export const REWORK_MEMBERSHIP_LABELS: Record<ReworkMembership, string> = {
  BASELINE_ONLY: '仅原件（返工已修复）',
  REWORK_ONLY: '仅返工件（新引入）',
  BOTH: '两边仍削波（未修复）',
  BASELINE_UNCOMPARED: '原件区间（超出重叠，不可比较）',
  REWORK_UNCOMPARED: '返工区间（超出重叠，不可比较）'
};

/** 落在重叠区内、参与质量裁决的三种标记 */
export const COMPARED_MEMBERSHIPS: ReadonlySet<ReworkMembership> = new Set([
  'BASELINE_ONLY',
  'REWORK_ONLY',
  'BOTH'
]);

export interface ReworkDiffSegment {
  membership: ReworkMembership;
  /** 基线文件坐标（首帧含 / 末帧含）；REWORK_UNCOMPARED 片段为 null */
  baselineFrame: { startFrame: number; endFrame: number } | null;
  /** 返工文件坐标（首帧含 / 末帧含）；BASELINE_UNCOMPARED 片段为 null */
  reworkFrame: { startFrame: number; endFrame: number } | null;
  /** 以下时间字段仅用于展示与定位试听，按各文件自身坐标换算 */
  baselineStartSeconds: number | null;
  baselineEndSeconds: number | null;
  baselineStartMs: number | null;
  baselineEndMs: number | null;
  reworkStartSeconds: number | null;
  reworkEndSeconds: number | null;
  reworkStartMs: number | null;
  reworkEndMs: number | null;
}

export interface ReworkChannelDiff {
  channel: number;
  segments: ReworkDiffSegment[];
  /** 重叠区（基线坐标，含端点） */
  overlapBaseline: { startFrame: number; endFrame: number } | null;
  /** 重叠区（返工坐标，含端点） */
  overlapRework: { startFrame: number; endFrame: number } | null;
  baselineOnlyCount: number;
  reworkOnlyCount: number;
  bothCount: number;
  uncomparedCount: number;
}

/** 一次完整的返工对照结果：差异表、双波形与试听共用同一对象 */
export interface ReworkComparison {
  baseline: ScanResult;
  rework: ScanResult;
  /** 本次对齐使用的锚点参数 */
  anchor: AnchorParams;
  /** 唯一对齐结果 */
  alignment: AlignmentResult;
  /** 逐声道差异片段（差异表 / 双波形 / 试听共用） */
  channels: ReworkChannelDiff[];
  /** 合计：重叠区内仅基线（确认为已修复）的片段数 */
  fixedCount: number;
  /** 合计：重叠区内返工新引入的片段数 */
  introducedCount: number;
  /** 合计：重叠区内两边仍削波（未修复）的片段数 */
  remainingCount: number;
  /** 合计：落在重叠区外、不可比较的片段数 */
  uncomparedCount: number;
}

/** 两个等长扫描才能对照：采样率必须一致，否则帧/时间换算无意义 */
export class ReworkMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReworkMismatchError';
  }
}

/** 帧区间（含端点）按偏移映射到另一套坐标；不做裁剪 */
function shiftRange(
  startFrame: number,
  endFrame: number,
  offset: number
): { startFrame: number; endFrame: number } {
  return { startFrame: startFrame + offset, endFrame: endFrame + offset };
}

/**
 * 单声道：在真实重叠的原始帧范围内切片。
 *
 * 事件完全发生在帧边界：
 * - 覆盖事件（COVER）在帧 f 处改变“该帧是否被该文件扫描覆盖”；
 * - 区间事件（CLIP）在帧 f 处改变“该帧是否落在削波段内”。
 * 同一事件帧先应用结束事件、再应用开始事件，保证 [s,e] 语义精确
 * （段在 e 之后消失、在 s 处出现），成员集合恒定的相邻帧并为同一片段。
 */
export function diffReworkChannel(
  baselineSegments: ClipSegment[],
  reworkSegments: ClipSegment[],
  baselineFrameCount: number,
  reworkFrameCount: number,
  offset: number,
  sampleRate: number,
  channel: number
): ReworkChannelDiff {
  // 重叠区：基线坐标 [bLo, bHi]（含端点），返工坐标 = +offset。
  // 任一侧帧数为 0（不应发生，NO_TRACK 已拦截）则该声道无重叠。
  let overlapBaseline: { startFrame: number; endFrame: number } | null = null;
  let overlapRework: { startFrame: number; endFrame: number } | null = null;
  if (baselineFrameCount > 0 && reworkFrameCount > 0) {
    const bLo = Math.max(0, -offset);
    const bHi = Math.min(baselineFrameCount - 1, reworkFrameCount - 1 - offset);
    if (bHi >= bLo) {
      overlapBaseline = { startFrame: bLo, endFrame: bHi };
      overlapRework = shiftRange(bLo, bHi, offset);
    }
  }

  type CoverKind = 'B' | 'R';
  type ClipKind = 'B' | 'R';
  interface CoverEvent {
    kind: 'cover';
    who: CoverKind;
    frame: number; // 基线坐标
    end: boolean;
  }
  interface ClipEvent {
    kind: 'clip';
    who: ClipKind;
    frame: number; // 基线坐标
    end: boolean;
  }
  type Ev = CoverEvent | ClipEvent;

  const events: Ev[] = [];

  // 每份扫描对各自整个 PCM 帧范围都有“覆盖”：coverB/coverR 表示该文件
  // 物理存在的帧（决定未覆盖区域 INCOMPARABLE）；两者同时覆盖即真实重叠，
  // 才做质量裁决。这样基线段落在自身 PCM 内、却在重叠外时
  // 会得到 BASELINE_UNCOMPARED，而不是被静默丢弃。
  if (baselineFrameCount > 0) {
    events.push({ kind: 'cover', who: 'B', frame: 0, end: false });
    events.push({ kind: 'cover', who: 'B', frame: baselineFrameCount, end: true });
  }
  // 返工 PCM 覆盖区映射回基线坐标：[-offset, reworkFrameCount-1-offset]
  if (reworkFrameCount > 0) {
    events.push({ kind: 'cover', who: 'R', frame: -offset, end: false });
    events.push({
      kind: 'cover',
      who: 'R',
      frame: reworkFrameCount - offset,
      end: true
    });
  }

  // 削波区间事件：返工区间先映射回基线坐标
  for (const seg of baselineSegments) {
    events.push({ kind: 'clip', who: 'B', frame: seg.startFrame, end: false });
    events.push({ kind: 'clip', who: 'B', frame: seg.endFrame + 1, end: true });
  }
  for (const seg of reworkSegments) {
    const startB = seg.startFrame - offset;
    const endB = seg.endFrame - offset;
    events.push({ kind: 'clip', who: 'R', frame: startB, end: false });
    events.push({ kind: 'clip', who: 'R', frame: endB + 1, end: true });
  }

  // 同帧先结束后开始（结束事件 end=true 先），使覆盖空隙与区间缝隙
  // 不会被错误地并入相邻片段。事件帧可能为负（返工早开始时），
  // 统一按帧序扫描；负帧不在基线 PCM（帧从 0 起）内，不会误产出片段。
  events.sort((a, b) =>
    a.frame !== b.frame
      ? a.frame - b.frame
      : Number(b.end) - Number(a.end)
  );

  const segments: ReworkDiffSegment[] = [];
  let coverB = false;
  let coverR = false;
  let clipB = false;
  let clipR = false;
  let openStart = -1;
  let openKind: ReworkMembership | null = null;

  const membershipAt = (): ReworkMembership | null => {
    // 真实重叠（两份扫描都覆盖）：三种质量裁决
    if (coverB && coverR) {
      return clipB
        ? clipR
          ? 'BOTH'
          : 'BASELINE_ONLY'
        : clipR
          ? 'REWORK_ONLY'
          : null;
    }
    // 只在一侧扫描范围内的削波 → 未覆盖区域，不可比较，不算任何一方独有
    if (coverB && !coverR && clipB) return 'BASELINE_UNCOMPARED';
    if (coverR && !coverB && clipR) return 'REWORK_UNCOMPARED';
    return null;
  };

  const pushSegment = (rawStart: number, rawEnd: number, kind: ReworkMembership) => {
    // 片段以基线坐标扫描，但返工早开始时返工独有片段映射到负的基线坐标；
    // 其返工坐标（raw+offset）仍是合法非负帧。因此按成员集合分别取坐标：
    // 比较类 / 基线独有：基线坐标必非负（覆盖区与基线 PCM 都从帧 0 起）；
    // 返工独有：只取返工坐标，必要时把起始钳到 0，整体为负才丢弃。
    let baselineFrame: { startFrame: number; endFrame: number } | null = null;
    let reworkFrame: { startFrame: number; endFrame: number } | null = null;

    if (kind === 'REWORK_UNCOMPARED') {
      // rawStart..rawEnd 内返工恒覆盖（coverR 仅覆盖返工 PCM 帧），
      // 平移后 rework 坐标必非负且 end>=start；起始仍钳到 0 以丢弃半段映射。
      const rStart = Math.max(0, rawStart + offset);
      const rEnd = rawEnd + offset;
      reworkFrame = { startFrame: rStart, endFrame: rEnd };
    } else if (kind === 'BASELINE_UNCOMPARED') {
      baselineFrame = { startFrame: Math.max(0, rawStart), endFrame: rawEnd };
    } else {
      baselineFrame = { startFrame: rawStart, endFrame: rawEnd };
      reworkFrame = shiftRange(rawStart, rawEnd, offset);
    }

    const bSec = baselineFrame
      ? {
          start: frameToStartSeconds(baselineFrame.startFrame, sampleRate),
          end: frameToEndSeconds(baselineFrame.endFrame, sampleRate)
        }
      : null;
    const rSec = reworkFrame
      ? {
          start: frameToStartSeconds(reworkFrame.startFrame, sampleRate),
          end: frameToEndSeconds(reworkFrame.endFrame, sampleRate)
        }
      : null;

    segments.push({
      membership: kind,
      baselineFrame,
      reworkFrame,
      baselineStartSeconds: bSec?.start ?? null,
      baselineEndSeconds: bSec?.end ?? null,
      baselineStartMs: bSec ? secondsToMs(bSec.start) : null,
      baselineEndMs: bSec ? secondsToMs(bSec.end) : null,
      reworkStartSeconds: rSec?.start ?? null,
      reworkEndSeconds: rSec?.end ?? null,
      reworkStartMs: rSec ? secondsToMs(rSec.start) : null,
      reworkEndMs: rSec ? secondsToMs(rSec.end) : null
    });
  };

  let i = 0;
  while (i < events.length) {
    const frame = events[i]!.frame;
    // 闭合上一段：上一事件帧之后、本事件帧之前成员集合恒定
    if (openKind !== null) {
      pushSegment(openStart, frame - 1, openKind);
      openKind = null;
    }
    // 应用同一帧的全部事件
    let j = i;
    while (j < events.length && events[j]!.frame === frame) {
      const ev = events[j]!;
      const on = !ev.end;
      if (ev.kind === 'cover') {
        if (ev.who === 'B') coverB = on;
        else coverR = on;
      } else {
        if (ev.who === 'B') clipB = on;
        else clipR = on;
      }
      j++;
    }
    const kind = membershipAt();
    if (kind !== null) openStart = frame;
    openKind = kind;
    i = j;
  }

  let baselineOnlyCount = 0;
  let reworkOnlyCount = 0;
  let bothCount = 0;
  let uncomparedCount = 0;
  for (const seg of segments) {
    if (seg.membership === 'BASELINE_ONLY') baselineOnlyCount++;
    else if (seg.membership === 'REWORK_ONLY') reworkOnlyCount++;
    else if (seg.membership === 'BOTH') bothCount++;
    else uncomparedCount++;
  }

  return {
    channel,
    segments,
    overlapBaseline,
    overlapRework,
    baselineOnlyCount,
    reworkOnlyCount,
    bothCount,
    uncomparedCount
  };
}

/**
 * 汇总返工对照：两份扫描必须采样率一致、声道路数一致；
 * 偏移对所有声道相同（锚点定出的整段录音错位）。
 */
export function buildReworkComparison(
  baseline: ScanResult,
  rework: ScanResult,
  anchor: AnchorParams,
  alignment: AlignmentResult
): ReworkComparison {
  if (baseline.sampleRate !== rework.sampleRate) {
    throw new ReworkMismatchError(
      `采样率不一致：原始 ${baseline.sampleRate} Hz、返工 ${rework.sampleRate} Hz，无法逐帧对照`
    );
  }
  if (baseline.channels.length !== rework.channels.length) {
    throw new ReworkMismatchError(
      `声道数不一致：原始 ${baseline.channels.length}、返工 ${rework.channels.length}，无法逐声道对照`
    );
  }

  const channels = baseline.channels.map((bch) => {
    const rch = rework.channels[bch.channel]!;
    return diffReworkChannel(
      bch.segments,
      rch.segments,
      bch.frameCount,
      rch.frameCount,
      alignment.offsetFrames,
      baseline.sampleRate,
      bch.channel
    );
  });

  let fixedCount = 0;
  let introducedCount = 0;
  let remainingCount = 0;
  let uncomparedCount = 0;
  for (const c of channels) {
    fixedCount += c.baselineOnlyCount;
    introducedCount += c.reworkOnlyCount;
    remainingCount += c.bothCount;
    uncomparedCount += c.uncomparedCount;
  }

  return {
    baseline,
    rework,
    anchor,
    alignment,
    channels,
    fixedCount,
    introducedCount,
    remainingCount,
    uncomparedCount
  };
}
