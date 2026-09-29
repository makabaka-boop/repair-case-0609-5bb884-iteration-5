import { describe, expect, it } from 'vitest';
import {
  DIFF_MEMBERSHIP_LABELS,
  INVALID_RULE_NOTICE,
  buildComparison,
  diffChannelSegments,
  parseCandidateRule,
  type DiffMembership
} from '../../src/audio/compare';
import {
  BASELINE_RULE,
  buildScanResult,
  scanChannelWithRule
} from '../../src/audio/scanner';
import type { ClipSegment } from '../../src/audio/types';

const SR = 1000;

/** 生成指定长度静音，再叠加各段（默认满幅 1） */
function build(
  length: number,
  runs: Array<{ start: number; length: number; value?: number }>
): Float32Array {
  const data = new Float32Array(length);
  for (const run of runs) {
    for (let i = 0; i < run.length; i++) {
      data[run.start + i] = run.value ?? 1;
    }
  }
  return data;
}

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

/**
 * 独立逐帧标记预言机：与实现的事件扫描完全无关。
 * 对并集覆盖范围内的每一帧直接判定成员集合，
 * 仅当“成员集合相同且帧相邻”时才并入同一片段。
 */
function oracleDiff(
  baseline: Array<[number, number]>,
  candidate: Array<[number, number]>
): Array<[number, number, DiffMembership]> {
  const all = [...baseline, ...candidate];
  if (all.length === 0) return [];
  const lo = Math.min(...all.map(([s]) => s));
  const hi = Math.max(...all.map(([, e]) => e));
  const out: Array<[number, number, DiffMembership]> = [];
  for (let f = lo; f <= hi; f++) {
    const inB = baseline.some(([s, e]) => s <= f && f <= e);
    const inC = candidate.some(([s, e]) => s <= f && f <= e);
    if (!inB && !inC) continue; // 覆盖空隙：不产出片段，也阻断相邻合并
    const kind: DiffMembership = inB
      ? inC
        ? 'BOTH'
        : 'BASELINE_ONLY'
      : 'CANDIDATE_ONLY';
    const last = out[out.length - 1];
    if (last && last[2] === kind && last[1] === f - 1) {
      last[1] = f;
    } else {
      out.push([f, f, kind]);
    }
  }
  return out;
}

/** 用预言机校验 diffChannelSegments 的逐帧输出 */
function expectDiffMatchesOracle(
  baseline: Array<[number, number]>,
  candidate: Array<[number, number]>
) {
  const result = diffChannelSegments(
    baseline.map(([s, e]) => seg(s, e)),
    candidate.map(([s, e]) => seg(s, e)),
    SR,
    0
  );
  const actual = result.segments.map(
    (s) => [s.startFrame, s.endFrame, s.membership] as const
  );
  expect(actual).toEqual(oracleDiff(baseline, candidate));
  return result;
}

describe('候选规则输入解析', () => {
  it('合法输入解析为规则对象', () => {
    expect(
      parseCandidateRule({
        threshold: '0.999',
        minRunFrames: '3',
        maxMergeGap: '2'
      })
    ).toEqual({ threshold: 0.999, minRunFrames: 3, maxMergeGap: 2 });
  });

  it('阈值边界：恰为 1 合法，0 / 负数 / 大于 1 / 非数字 / 空均非法', () => {
    const base = { minRunFrames: '3', maxMergeGap: '2' };
    expect(parseCandidateRule({ ...base, threshold: '1' })).toEqual({
      threshold: 1,
      minRunFrames: 3,
      maxMergeGap: 2
    });
    for (const bad of ['0', '-0.5', '1.0001', 'abc', '', '  ']) {
      expect(parseCandidateRule({ ...base, threshold: bad })).toBeNull();
    }
  });

  it('最短连续帧：正整数合法，0 / 负数 / 小数 / 空均非法', () => {
    const base = { threshold: '0.999', maxMergeGap: '2' };
    expect(parseCandidateRule({ ...base, minRunFrames: '1' })).not.toBeNull();
    for (const bad of ['0', '-1', '2.5', 'x', '']) {
      expect(parseCandidateRule({ ...base, minRunFrames: bad })).toBeNull();
    }
  });

  it('合并间隔：非负整数合法（含 0），负数 / 小数 / 空均非法', () => {
    const base = { threshold: '0.999', minRunFrames: '3' };
    expect(parseCandidateRule({ ...base, maxMergeGap: '0' })).toEqual({
      threshold: 0.999,
      minRunFrames: 3,
      maxMergeGap: 0
    });
    for (const bad of ['-1', '1.5', 'y', '']) {
      expect(parseCandidateRule({ ...base, maxMergeGap: bad })).toBeNull();
    }
  });

  it('非法提示文案存在', () => {
    expect(INVALID_RULE_NOTICE).toContain('候选规则非法');
  });
});

describe('按规则扫描单声道', () => {
  it('自定义阈值：0.5 阈值命中 0.6 样本，基线阈值不命中', () => {
    const data = build(10, [{ start: 2, length: 3, value: 0.6 }]);
    const candidate = scanChannelWithRule(data, SR, 0, {
      threshold: 0.5,
      minRunFrames: 3,
      maxMergeGap: 2
    });
    expect(candidate.segments).toHaveLength(1);
    expect(candidate.segments[0]).toMatchObject({ startFrame: 2, endFrame: 4 });
    const baseline = scanChannelWithRule(data, SR, 0, BASELINE_RULE);
    expect(baseline.segments).toHaveLength(0);
  });

  it('最短游程 1：单帧尖峰也成段', () => {
    const data = build(10, [{ start: 4, length: 1 }]);
    const r = scanChannelWithRule(data, SR, 0, {
      threshold: 0.999,
      minRunFrames: 1,
      maxMergeGap: 2
    });
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ startFrame: 4, endFrame: 4 });
  });

  it('合并间隔 0：相邻段间隔 1 帧也不合并', () => {
    const data = build(7, [
      { start: 0, length: 3 },
      { start: 4, length: 3 }
    ]);
    const r = scanChannelWithRule(data, SR, 0, {
      threshold: 0.999,
      minRunFrames: 3,
      maxMergeGap: 0
    });
    expect(r.segments).toHaveLength(2);
  });

  it('非法规则抛出 RangeError', () => {
    const data = build(4, [{ start: 0, length: 3 }]);
    expect(() =>
      scanChannelWithRule(data, SR, 0, {
        threshold: 0,
        minRunFrames: 3,
        maxMergeGap: 2
      })
    ).toThrow(RangeError);
    expect(() =>
      scanChannelWithRule(data, SR, 0, {
        threshold: 1.5,
        minRunFrames: 3,
        maxMergeGap: 2
      })
    ).toThrow(RangeError);
    expect(() =>
      scanChannelWithRule(data, SR, 0, {
        threshold: 0.999,
        minRunFrames: 0,
        maxMergeGap: 2
      })
    ).toThrow(RangeError);
    expect(() =>
      scanChannelWithRule(data, SR, 0, {
        threshold: 0.999,
        minRunFrames: 3,
        maxMergeGap: -1
      })
    ).toThrow(RangeError);
  });
});

describe('差异切片（逐帧预言机校验）', () => {
  it('嵌套：候选区间完全落在基线区间内部', () => {
    const result = expectDiffMatchesOracle([[0, 9]], [[3, 5]]);
    expect(result.segments.map((s) => s.membership)).toEqual([
      'BASELINE_ONLY',
      'BOTH',
      'BASELINE_ONLY'
    ]);
    expect(result.baselineOnlyCount).toBe(2);
    expect(result.bothCount).toBe(1);
    expect(result.candidateOnlyCount).toBe(0);
  });

  it('嵌套（反向）：基线区间完全落在候选区间内部', () => {
    const result = expectDiffMatchesOracle([[3, 5]], [[0, 9]]);
    expect(result.segments.map((s) => s.membership)).toEqual([
      'CANDIDATE_ONLY',
      'BOTH',
      'CANDIDATE_ONLY'
    ]);
  });

  it('相交：两套区间部分重叠', () => {
    const result = expectDiffMatchesOracle([[0, 4]], [[2, 6]]);
    expect(
      result.segments.map((s) => [s.startFrame, s.endFrame, s.membership])
    ).toEqual([
      [0, 1, 'BASELINE_ONLY'],
      [2, 4, 'BOTH'],
      [5, 6, 'CANDIDATE_ONLY']
    ]);
  });

  it('相邻区间：成员集合不同，帧相邻也不合并', () => {
    // 基线 [0..2] 与候选 [3..5] 帧相邻，但成员集合不同 → 两个片段
    const result = expectDiffMatchesOracle([[0, 2]], [[3, 5]]);
    expect(
      result.segments.map((s) => [s.startFrame, s.endFrame, s.membership])
    ).toEqual([
      [0, 2, 'BASELINE_ONLY'],
      [3, 5, 'CANDIDATE_ONLY']
    ]);
  });

  it('相邻区间：成员集合相同且帧相邻必须合并为一片', () => {
    // 同一集合内两段相邻区间 [0..2]、[3..5]（事件帧 3 上 -1/+1 相抵）
    const result = expectDiffMatchesOracle(
      [
        [0, 2],
        [3, 5]
      ],
      []
    );
    expect(
      result.segments.map((s) => [s.startFrame, s.endFrame, s.membership])
    ).toEqual([[0, 5, 'BASELINE_ONLY']]);
  });

  it('覆盖空隙：成员集合相同但不帧相邻，不得合并', () => {
    // [0..2] 与 [4..6] 之间帧 3 无覆盖 → 两个独立片段
    const result = expectDiffMatchesOracle(
      [
        [0, 2],
        [4, 6]
      ],
      [
        [0, 2],
        [4, 6]
      ]
    );
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toMatchObject({ startFrame: 0, endFrame: 2 });
    expect(result.segments[1]).toMatchObject({ startFrame: 4, endFrame: 6 });
  });

  it('多套交叠：逐帧切片与预言机一致', () => {
    expectDiffMatchesOracle(
      [
        [0, 4],
        [10, 12]
      ],
      [
        [2, 6],
        [11, 15]
      ]
    );
  });

  it('两套均为空：无差异片段', () => {
    const result = diffChannelSegments([], [], SR, 0);
    expect(result.segments).toEqual([]);
    expect(result.baselineOnlyCount).toBe(0);
    expect(result.candidateOnlyCount).toBe(0);
    expect(result.bothCount).toBe(0);
  });

  it('毫秒字段仅用于展示：边界裁决不受毫秒取整影响', () => {
    // 采样率 8000：帧 1 起止毫秒均为 0.125ms 级，四舍五入后相邻片段
    // 显示毫秒可能相同，但帧边界必须精确切分
    const sr = 8000;
    const result = diffChannelSegments(
      [seg(0, 4)],
      [
        {
          ...seg(2, 6),
          startSeconds: 2 / sr,
          endSeconds: 7 / sr,
          durationSeconds: 5 / sr
        }
      ],
      sr,
      0
    );
    expect(
      result.segments.map((s) => [s.startFrame, s.endFrame, s.membership])
    ).toEqual([
      [0, 1, 'BASELINE_ONLY'],
      [2, 4, 'BOTH'],
      [5, 6, 'CANDIDATE_ONLY']
    ]);
    // 展示字段由帧换算：首段 0–1 帧 → 0ms–0.25ms→0ms（half-up）；
    // 次段 2–4 帧 → 0.25ms→0ms 起、0.625ms→1ms 止。
    // 两段显示起点同为 0ms，但帧边界 [0,1] / [2,4] 精确区分。
    expect(result.segments[0]).toMatchObject({ startMs: 0, endMs: 0 });
    expect(result.segments[1]).toMatchObject({ startMs: 0, endMs: 1 });
  });

  it('标记文案覆盖三种成员集合', () => {
    expect(DIFF_MEMBERSHIP_LABELS.BASELINE_ONLY).toContain('仅基线');
    expect(DIFF_MEMBERSHIP_LABELS.CANDIDATE_ONLY).toContain('仅候选');
    expect(DIFF_MEMBERSHIP_LABELS.BOTH).toContain('共有');
  });
});

describe('候选规则比较（复用已解码 PCM）', () => {
  it('阈值相等：候选规则与基线完全一致 → 全部 BOTH，无差异', () => {
    const data = build(30, [
      { start: 2, length: 4 },
      { start: 12, length: 5 }
    ]);
    const baseline = buildScanResult('a.wav', [data], SR);
    const comparison = buildComparison(baseline, {
      threshold: 0.999,
      minRunFrames: 3,
      maxMergeGap: 2
    });
    expect(comparison.hasDifference).toBe(false);
    expect(comparison.baselineOnlyCount).toBe(0);
    expect(comparison.candidateOnlyCount).toBe(0);
    expect(comparison.bothCount).toBe(2);
    expect(comparison.channels[0]!.segments.map((s) => s.membership)).toEqual([
      'BOTH',
      'BOTH'
    ]);
    // 候选结论与段数同基线一致
    expect(comparison.candidate.hasClip).toBe(true);
    expect(comparison.candidate.channels[0]!.segments).toHaveLength(2);
    expect(comparison.candidate.totalClipMs).toBe(baseline.totalClipMs);
  });

  it('最短游程变严：基线段整体成为 BASELINE_ONLY（结论翻转）', () => {
    // 5 帧削波：基线（3 帧）成段；候选要求 10 帧 → 无段
    const data = build(60, [{ start: 20, length: 5 }]);
    const baseline = buildScanResult('b.wav', [data], SR);
    const comparison = buildComparison(baseline, {
      threshold: 0.999,
      minRunFrames: 10,
      maxMergeGap: 2
    });
    expect(comparison.hasDifference).toBe(true);
    expect(comparison.candidate.hasClip).toBe(false);
    expect(comparison.baselineOnlyCount).toBe(1);
    expect(comparison.candidateOnlyCount).toBe(0);
    const diff = comparison.channels[0]!;
    expect(
      diff.segments.map((s) => [s.startFrame, s.endFrame, s.membership])
    ).toEqual([[20, 24, 'BASELINE_ONLY']]);
  });

  it('最短游程放宽：新规则新增 CANDIDATE_ONLY 片段', () => {
    // 2 帧尖峰：基线（3 帧）不成段；候选（1 帧）成段
    const data = build(20, [{ start: 5, length: 2 }]);
    const baseline = buildScanResult('c.wav', [data], SR);
    expect(baseline.hasClip).toBe(false);
    const comparison = buildComparison(baseline, {
      threshold: 0.999,
      minRunFrames: 1,
      maxMergeGap: 2
    });
    expect(comparison.hasDifference).toBe(true);
    expect(comparison.candidate.hasClip).toBe(true);
    expect(
      comparison.channels[0]!.segments.map((s) => [
        s.startFrame,
        s.endFrame,
        s.membership
      ])
    ).toEqual([[5, 6, 'CANDIDATE_ONLY']]);
  });

  it('合并间隙变严：基线合并段被切开，中间成为 BASELINE_ONLY', () => {
    // 游程 [0..2] 与 [5..7]，间隔 2 帧：基线合并为 [0..7]；
    // 候选间隔 0 → 两段 [0..2]、[5..7]，帧 3..4 仅基线
    const data = build(8, [
      { start: 0, length: 3 },
      { start: 5, length: 3 }
    ]);
    const baseline = buildScanResult('d.wav', [data], SR);
    expect(baseline.channels[0]!.segments).toHaveLength(1);
    const comparison = buildComparison(baseline, {
      threshold: 0.999,
      minRunFrames: 3,
      maxMergeGap: 0
    });
    expect(comparison.candidate.channels[0]!.segments).toHaveLength(2);
    expect(
      comparison.channels[0]!.segments.map((s) => [
        s.startFrame,
        s.endFrame,
        s.membership
      ])
    ).toEqual([
      [0, 2, 'BOTH'],
      [3, 4, 'BASELINE_ONLY'],
      [5, 7, 'BOTH']
    ]);
  });

  it('合并间隙放宽：候选把基线两段并为一段，中间成为 CANDIDATE_ONLY', () => {
    // 游程 [0..2] 与 [6..8]，间隔 3 帧：基线不合并；候选间隔 3 → 合并 [0..8]
    const data = build(9, [
      { start: 0, length: 3 },
      { start: 6, length: 3 }
    ]);
    const baseline = buildScanResult('e.wav', [data], SR);
    expect(baseline.channels[0]!.segments).toHaveLength(2);
    const comparison = buildComparison(baseline, {
      threshold: 0.999,
      minRunFrames: 3,
      maxMergeGap: 3
    });
    expect(comparison.candidate.channels[0]!.segments).toHaveLength(1);
    expect(
      comparison.channels[0]!.segments.map((s) => [
        s.startFrame,
        s.endFrame,
        s.membership
      ])
    ).toEqual([
      [0, 2, 'BOTH'],
      [3, 5, 'CANDIDATE_ONLY'],
      [6, 8, 'BOTH']
    ]);
  });

  it('阈值放宽：低于基线阈值的样本帧成为 CANDIDATE_ONLY', () => {
    // 帧 0..4 满幅，帧 5..6 为 0.6：基线 [0..4]；候选阈值 0.5 → [0..6]
    const data = build(10, [
      { start: 0, length: 5 },
      { start: 5, length: 2, value: 0.6 }
    ]);
    const baseline = buildScanResult('f.wav', [data], SR);
    const comparison = buildComparison(baseline, {
      threshold: 0.5,
      minRunFrames: 3,
      maxMergeGap: 2
    });
    expect(
      comparison.channels[0]!.segments.map((s) => [
        s.startFrame,
        s.endFrame,
        s.membership
      ])
    ).toEqual([
      [0, 4, 'BOTH'],
      [5, 6, 'CANDIDATE_ONLY']
    ]);
  });

  it('多声道：逐声道独立切片，合计计数分别累加', () => {
    // 左声道 5 帧削波，右声道干净；候选要求 10 帧 → 仅左声道有 BASELINE_ONLY
    const left = build(60, [{ start: 20, length: 5 }]);
    const right = new Float32Array(60);
    const baseline = buildScanResult('stereo.wav', [left, right], SR);
    const comparison = buildComparison(baseline, {
      threshold: 0.999,
      minRunFrames: 10,
      maxMergeGap: 2
    });
    expect(comparison.channels).toHaveLength(2);
    expect(comparison.channels[0]!.channel).toBe(0);
    expect(comparison.channels[0]!.segments).toHaveLength(1);
    expect(comparison.channels[0]!.baselineOnlyCount).toBe(1);
    expect(comparison.channels[1]!.segments).toHaveLength(0);
    expect(comparison.channels[1]!.baselineOnlyCount).toBe(0);
    expect(comparison.baselineOnlyCount).toBe(1);
    expect(comparison.candidateOnlyCount).toBe(0);
    expect(comparison.bothCount).toBe(0);
    // 候选结论：全声道无段 → 可交付（hasClip=false）
    expect(comparison.candidate.hasClip).toBe(false);
    expect(comparison.candidate.channels[1]!.segments).toHaveLength(0);
  });

  it('多声道：候选新增片段只出现在对应声道', () => {
    // 右声道 2 帧尖峰：基线无段；候选 minRun=1 → 右声道 CANDIDATE_ONLY
    const left = new Float32Array(30);
    const right = build(30, [{ start: 10, length: 2 }]);
    const baseline = buildScanResult('stereo2.wav', [left, right], SR);
    const comparison = buildComparison(baseline, {
      threshold: 0.999,
      minRunFrames: 1,
      maxMergeGap: 2
    });
    expect(comparison.channels[0]!.segments).toHaveLength(0);
    expect(
      comparison.channels[1]!.segments.map((s) => [
        s.startFrame,
        s.endFrame,
        s.membership
      ])
    ).toEqual([[10, 11, 'CANDIDATE_ONLY']]);
    expect(comparison.candidateOnlyCount).toBe(1);
    // 候选扫描复用同一解码 PCM 引用，不复制缓冲
    expect(comparison.candidate.channelData).toBe(baseline.channelData);
  });

  it('比较结果携带候选规则原文', () => {
    const baseline = buildScanResult('g.wav', [new Float32Array(8)], SR);
    const rule = { threshold: 0.8, minRunFrames: 2, maxMergeGap: 1 };
    const comparison = buildComparison(baseline, rule);
    expect(comparison.rule).toEqual(rule);
    expect(comparison.hasDifference).toBe(false);
  });
});
