import { describe, expect, it } from 'vitest';
import {
  ReworkMismatchError,
  buildReworkComparison,
  diffReworkChannel
} from '../../src/audio/rework-compare';
import { buildScanResult } from '../../src/audio/scanner';
import type { ClipSegment } from '../../src/audio/types';
import type { AlignmentResult } from '../../src/audio/alignment';

const SR = 1000;

function seg(start: number, end: number): ClipSegment {
  return {
    startFrame: start,
    endFrame: end,
    startSeconds: start / SR,
    endSeconds: (end + 1) / SR,
    durationSeconds: (end - start + 1) / SR,
    startMs: start,
    endMs: end + 1,
    durationMs: end - start + 1
  };
}

/** 满幅片段 PCM（基线 0.999 阈值，≥3 帧成段） */
function pcm(
  length: number,
  runs: Array<{ start: number; end: number }>
): Float32Array {
  const data = new Float32Array(length);
  for (const r of runs) {
    for (let i = r.start; i <= r.end; i++) data[i] = 1;
  }
  return data;
}

const aligned: AlignmentResult = {
  offsetFrames: 0,
  score: 1,
  comparedFrames: 10,
  anchorRms: 0.5
};

describe('diffReworkChannel 真实重叠帧范围内裁决', () => {
  it('偏移 0、等长：同位置削波为 BOTH（仍未修复）', () => {
    const r = diffReworkChannel([seg(10, 14)], [seg(10, 14)], 100, 100, 0, SR, 0);
    expect(r.overlapBaseline).toEqual({ startFrame: 0, endFrame: 99 });
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.membership).toBe('BOTH');
    expect(r.bothCount).toBe(1);
    expect(r.baselineOnlyCount).toBe(0);
  });

  it('偏移 0：基线有、返工无 → BASELINE_ONLY（确认修复），坐标两套相同', () => {
    const r = diffReworkChannel([seg(10, 14)], [], 100, 100, 0, SR, 0);
    expect(r.segments.map((s) => [s.membership])).toEqual([['BASELINE_ONLY']]);
    const s = r.segments[0]!;
    expect(s.baselineFrame).toEqual({ startFrame: 10, endFrame: 14 });
    expect(s.reworkFrame).toEqual({ startFrame: 10, endFrame: 14 });
    expect(s.baselineStartMs).toBe(10);
    expect(s.reworkStartMs).toBe(10);
    expect(r.baselineOnlyCount).toBe(1);
  });

  it('偏移 0：返工新引入一段 → REWORK_ONLY（新引入）', () => {
    const r = diffReworkChannel([], [seg(30, 33)], 100, 100, 0, SR, 0);
    expect(r.segments[0]!.membership).toBe('REWORK_ONLY');
    expect(r.reworkOnlyCount).toBe(1);
  });

  it('正偏移 +10：返工帧 = 基线帧 + 10；基线段 [20,24] 对应返工 [30,34]', () => {
    // 若不错位比较会误判成“修复 + 新引入”；对齐后必须裁决 BOTH
    const r = diffReworkChannel(
      [seg(20, 24)],
      [seg(30, 34)],
      100,
      110,
      10,
      SR,
      0
    );
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.membership).toBe('BOTH');
    expect(r.segments[0]!.baselineFrame).toEqual({ startFrame: 20, endFrame: 24 });
    expect(r.segments[0]!.reworkFrame).toEqual({ startFrame: 30, endFrame: 34 });
    expect(r.overlapBaseline).toEqual({ startFrame: 0, endFrame: 99 });
    expect(r.overlapRework).toEqual({ startFrame: 10, endFrame: 109 });
  });

  it('负偏移 −10：返工早开始，同一段内容在返工坐标前移 10 帧仍裁决 BOTH', () => {
    const r = diffReworkChannel(
      [seg(20, 24)],
      [seg(10, 14)],
      100,
      100,
      -10,
      SR,
      0
    );
    expect(r.segments[0]!.membership).toBe('BOTH');
    expect(r.segments[0]!.reworkFrame).toEqual({ startFrame: 10, endFrame: 14 });
    expect(r.overlapRework).toEqual({ startFrame: 0, endFrame: 89 });
    expect(r.overlapBaseline).toEqual({ startFrame: 10, endFrame: 99 });
  });

  it('确属修复（不是错位）：+10 对齐后基线段在返工中消失 → BASELINE_ONLY', () => {
    const r = diffReworkChannel(
      [seg(20, 24)],
      [seg(50, 53)],
      100,
      110,
      10,
      SR,
      0
    );
    const kinds = r.segments.map((s) => s.membership).sort();
    expect(kinds).toEqual(['BASELINE_ONLY', 'REWORK_ONLY']);
  });

  it('长度不等 + 偏移：基线段落在返工未覆盖区 → BASELINE_UNCOMPARED，不算独有', () => {
    // 基线 100 帧、返工 50 帧、偏移 +10：重叠（基线坐标）[0, 39]。
    // 基线段 [50, 54] 在重叠外 → 不可比较；返工段 [20,24]→基线 [10,14] 在重叠内
    const r = diffReworkChannel(
      [seg(50, 54), seg(10, 14)],
      [seg(20, 24)],
      100,
      50,
      10,
      SR,
      0
    );
    const byKind = new Map(r.segments.map((s) => [s.membership, s]));
    expect(byKind.get('BASELINE_UNCOMPARED')?.baselineFrame).toEqual({
      startFrame: 50,
      endFrame: 54
    });
    // 不可比较片段没有返工坐标
    expect(byKind.get('BASELINE_UNCOMPARED')?.reworkFrame).toBeNull();
    expect(byKind.get('BASELINE_UNCOMPARED')?.reworkStartMs).toBeNull();
    expect(byKind.get('BOTH')?.baselineFrame).toEqual({ startFrame: 10, endFrame: 14 });
    expect(r.uncomparedCount).toBe(1);
    expect(r.baselineOnlyCount).toBe(0);
    expect(r.reworkOnlyCount).toBe(0);
  });

  it('返工比基线长：返工段在真实重叠外（返工独有开头/结尾）→ REWORK_UNCOMPARED', () => {
    // 基线 50 帧、返工 100 帧、偏移 −10：重叠基线坐标 [10, 49]，返工坐标 [0, 39]。
    // 返工段 [0,4] → 映射基线 [10,14]，恰为重叠起点，属于重叠内（REWORK_ONLY）；
    // 返工段 [45,49] → 映射基线 [55,59]，超出基线 PCM（仅返工覆盖）→ 不可比较。
    const r = diffReworkChannel(
      [],
      [seg(0, 4), seg(45, 49)],
      50,
      100,
      -10,
      SR,
      0
    );
    const uncomp = r.segments.filter((s) => s.membership === 'REWORK_UNCOMPARED');
    expect(uncomp).toHaveLength(1);
    expect(uncomp[0]!.reworkFrame).toEqual({ startFrame: 45, endFrame: 49 });
    expect(uncomp[0]!.baselineFrame).toBeNull();
    const only = r.segments.filter((s) => s.membership === 'REWORK_ONLY');
    expect(only).toHaveLength(1);
    expect(only[0]!.reworkFrame).toEqual({ startFrame: 0, endFrame: 4 });
    expect(only[0]!.baselineFrame).toEqual({ startFrame: 10, endFrame: 14 });
    expect(r.reworkOnlyCount).toBe(1);
    expect(r.uncomparedCount).toBe(1);
  });

  it('重叠区相交但部分重叠的段：逐帧切成 BOTH 与 ONLY，不错位吞并', () => {
    // 偏移 0：基线 [10,18]、返工 [15,22] → [10,14] BASELINE_ONLY、
    // [15,18] BOTH、[19,22] REWORK_ONLY
    const r = diffReworkChannel(
      [seg(10, 18)],
      [seg(15, 22)],
      100,
      100,
      0,
      SR,
      2
    );
    expect(
      r.segments.map((s) => [
        s.membership,
        s.baselineFrame?.startFrame ?? null,
        s.baselineFrame?.endFrame ?? null
      ])
    ).toEqual([
      ['BASELINE_ONLY', 10, 14],
      ['BOTH', 15, 18],
      ['REWORK_ONLY', 19, 22]
    ]);
    expect(r.channel).toBe(2);
  });

  it('成员集合相同且帧相邻才合并；覆盖空隙阻断合并', () => {
    // 偏移 0：基线两段 [10,12]、[14,16]（帧 13 无覆盖标记差异但仍为覆盖区，
    // 成员集合同为 BASELINE_ONLY 且帧 12/14 不相邻——帧 13 处集合为 null），
    // 中间帧 13 既非基线也非返工削波 → 两段不得跨空隙合并
    const r = diffReworkChannel(
      [seg(10, 12), seg(14, 16)],
      [],
      100,
      100,
      0,
      SR,
      0
    );
    expect(r.segments).toHaveLength(2);
    expect(r.segments.every((s) => s.membership === 'BASELINE_ONLY')).toBe(true);
  });

  it('无任何真实重叠（偏移让两份 PCM 完全错开）：全部基线段不可比较', () => {
    // 基线 100、返工 100、偏移 +200：bLo=max(0,-200)=0, bHi=min(99, -101) < bLo
    const r = diffReworkChannel(
      [seg(0, 4)],
      [seg(0, 4)],
      100,
      100,
      200,
      SR,
      0
    );
    expect(r.overlapBaseline).toBeNull();
    expect(r.overlapRework).toBeNull();
    // 基线 [0,4] 处返工不覆盖 → BASELINE_UNCOMPARED；返工 [0,4]→基线[-200..]
    // 基线不覆盖 → REWORK_UNCOMPARED
    expect(r.uncomparedCount).toBe(2);
    expect(r.bothCount + r.baselineOnlyCount + r.reworkOnlyCount).toBe(0);
  });

  it('返工早开始且无重叠：返工段映射为负基线帧，仍以返工坐标标 REWORK_UNCOMPARED', () => {
    // 基线 100、返工 100、偏移 −200：返工 [0,4] 映射基线 [200,204]，仅返工覆盖；
    // 基线 [0,4] 映射返工 [-200,-196]，仅基线覆盖。两侧各自报不可比较。
    const r = diffReworkChannel(
      [seg(0, 4)],
      [seg(0, 4)],
      100,
      100,
      -200,
      SR,
      0
    );
    const kinds = r.segments.map((s) => s.membership).sort();
    expect(kinds).toEqual(['BASELINE_UNCOMPARED', 'REWORK_UNCOMPARED']);
    const rew = r.segments.find((s) => s.membership === 'REWORK_UNCOMPARED')!;
    expect(rew.reworkFrame).toEqual({ startFrame: 0, endFrame: 4 });
    expect(rew.baselineFrame).toBeNull();
  });
});

describe('buildReworkComparison 汇总与守卫', () => {
  it('合成移位 PCM：偏移对齐后两段真实修复 + 一段仍削波，计数正确', () => {
    // 基线 300 帧：[20,24] 将被修复；[100,104] 返工保留（移位后同位置）
    const basePcm = pcm(300, [
      { start: 20, end: 24 },
      { start: 100, end: 104 }
    ]);
    // 返工晚开始 +37 帧：只保留第二段（平移到 137..141），第一段修复掉
    const rewPcm = pcm(340, [{ start: 137, end: 141 }]);
    const baseline = buildScanResult('orig.wav', [basePcm], SR);
    const rework = buildScanResult('redo.wav', [rewPcm], SR);
    const cmp = buildReworkComparison(
      baseline,
      rework,
      {
        anchorStartFrame: 50,
        anchorLengthFrames: 40,
        maxOffsetFrames: 80,
        channel: 0
      },
      { ...aligned, offsetFrames: 37 }
    );
    expect(cmp.fixedCount).toBe(1);
    expect(cmp.remainingCount).toBe(1);
    expect(cmp.introducedCount).toBe(0);
    expect(cmp.uncomparedCount).toBe(0);
    const fixed = cmp.channels[0]!.segments.find(
      (s) => s.membership === 'BASELINE_ONLY'
    )!;
    expect(fixed.baselineFrame).toEqual({ startFrame: 20, endFrame: 24 });
    expect(fixed.reworkFrame).toEqual({ startFrame: 57, endFrame: 61 });
  });

  it('多声道：逐声道独立切片并合计计数', () => {
    const bl = pcm(200, [{ start: 10, end: 14 }]);
    const br = pcm(200, [{ start: 30, end: 34 }]);
    // 左声道修复，右声道保留
    const rl = new Float32Array(200);
    const rr = pcm(200, [{ start: 30, end: 34 }]);
    const baseline = buildScanResult('s.wav', [bl, br], SR);
    const rework = buildScanResult('s2.wav', [rl, rr], SR);
    const cmp = buildReworkComparison(baseline, rework, {
      anchorStartFrame: 0,
      anchorLengthFrames: 1,
      maxOffsetFrames: 0,
      channel: 0
    }, aligned);
    expect(cmp.channels).toHaveLength(2);
    expect(cmp.fixedCount).toBe(1);
    expect(cmp.remainingCount).toBe(1);
    expect(cmp.channels[0]!.baselineOnlyCount).toBe(1);
    expect(cmp.channels[1]!.bothCount).toBe(1);
  });

  it('采样率不一致：抛 ReworkMismatchError', () => {
    const baseline = buildScanResult('a.wav', [pcm(100, [])], 8000);
    const rework = buildScanResult('b.wav', [pcm(100, [])], 44100);
    expect(() =>
      buildReworkComparison(baseline, rework, {
        anchorStartFrame: 0,
        anchorLengthFrames: 1,
        maxOffsetFrames: 0,
        channel: 0
      }, aligned)
    ).toThrow(ReworkMismatchError);
  });

  it('声道数不一致：抛 ReworkMismatchError', () => {
    const baseline = buildScanResult('a.wav', [pcm(100, []), pcm(100, [])], SR);
    const rework = buildScanResult('b.wav', [pcm(100, [])], SR);
    expect(() =>
      buildReworkComparison(baseline, rework, {
        anchorStartFrame: 0,
        anchorLengthFrames: 1,
        maxOffsetFrames: 0,
        channel: 0
      }, aligned)
    ).toThrow(ReworkMismatchError);
  });

  it('结果同时携带锚点、对齐与两份扫描引用（差异表/双波形/试听共用）', () => {
    const baseline = buildScanResult('a.wav', [pcm(100, [{ start: 5, end: 9 }])], SR);
    const rework = buildScanResult('b.wav', [pcm(100, [{ start: 5, end: 9 }])], SR);
    const anchor = {
      anchorStartFrame: 0,
      anchorLengthFrames: 10,
      maxOffsetFrames: 5,
      channel: 0
    };
    const alignment = { ...aligned, offsetFrames: 0, score: 0.9876 };
    const cmp = buildReworkComparison(baseline, rework, anchor, alignment);
    expect(cmp.anchor).toBe(anchor);
    expect(cmp.alignment).toBe(alignment);
    expect(cmp.baseline).toBe(baseline);
    expect(cmp.rework).toBe(rework);
    // 差异表、双波形、试听共用同一数组引用
    expect(cmp.channels[0]!.segments).toBe(cmp.channels[0]!.segments);
  });
});
