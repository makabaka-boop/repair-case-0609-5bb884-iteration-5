import { describe, expect, it } from 'vitest';
import {
  INVALID_ANCHOR_NOTICE,
  MIN_ANCHOR_FRAMES,
  MIN_ANCHOR_RMS,
  REWORK_DIFF_KIND_LABELS,
  alignedOverlapFrames,
  baselineSecondsToRework,
  baselineWaveMarks,
  buildReworkComparison,
  chooseBestLag,
  diffChannelRework,
  findBestAlignment,
  normalizedCrossCorrelation,
  offsetSign,
  parseAnchorSelection,
  reworkSecondsToBaseline,
  reworkWaveMarks,
  rms,
  type AnchorSelection
} from '../../src/audio/rework';
import { buildScanResult } from '../../src/audio/scanner';

const SR = 1000;
const selection = (
  overrides: Partial<AnchorSelection> = {}
): AnchorSelection => ({
  anchorStartSeconds: 0.02,
  anchorDurationSeconds: 0.04,
  channel: 0,
  maxOffsetFrames: 20,
  ...overrides
});

/** 确定性伪随机序列（非周期、非对称、非零均值），用作有效声音锚点 */
function pseudoNoise(length: number, seed = 7): Float32Array {
  const data = new Float32Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    // xorshift-ish
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[i] = ((state >>> 0) % 2000) / 1000 - 1 + (i % 7) * 0.003;
  }
  return data;
}

/** 构造基线与“整体移位 shift 帧”的返工 PCM（返工内容 = 基线内容平移） */
function shiftedPair(
  baseData: Float32Array,
  shift: number,
  reworkFrames?: number
): { baseline: Float32Array; rework: Float32Array } {
  const n = reworkFrames ?? baseData.length + shift;
  const rework = new Float32Array(Math.max(0, n));
  for (let f = 0; f < baseData.length; f++) {
    const r = f + shift;
    if (r >= 0 && r < rework.length) rework[r] = baseData[f]!;
  }
  return { baseline: baseData, rework };
}

function scan(
  name: string,
  channels: Float32Array[],
  sampleRate = SR
) {
  return buildScanResult(name, channels, sampleRate);
}

describe('锚点输入解析', () => {
  it('合法输入解析为数值选择', () => {
    expect(
      parseAnchorSelection({
        anchorStart: '0.02',
        anchorDuration: '0.04',
        channel: '1',
        maxOffsetFrames: '200'
      })
    ).toEqual({
      anchorStartSeconds: 0.02,
      anchorDurationSeconds: 0.04,
      channel: 1,
      maxOffsetFrames: 200
    });
  });

  it('起点 0 与两侧空格合法', () => {
    expect(parseAnchorSelection({
      anchorStart: ' 0 ',
      anchorDuration: '0.1',
      channel: '0',
      maxOffsetFrames: '0'
    })).toMatchObject({ anchorStartSeconds: 0, maxOffsetFrames: 0 });
  });

  it('空字段 / 起点为负 / 时长不大于零 / 声道负数 / 偏移负数或小数均非法', () => {
    const valid = {
      anchorStart: '0',
      anchorDuration: '0.1',
      channel: '0',
      maxOffsetFrames: '20'
    };
    expect(parseAnchorSelection({ ...valid, anchorStart: '' })).toBeNull();
    expect(parseAnchorSelection({ ...valid, anchorStart: '-1' })).toBeNull();
    expect(parseAnchorSelection({ ...valid, anchorStart: 'x' })).toBeNull();
    expect(parseAnchorSelection({ ...valid, anchorDuration: '' })).toBeNull();
    expect(parseAnchorSelection({ ...valid, anchorDuration: '0' })).toBeNull();
    expect(parseAnchorSelection({ ...valid, anchorDuration: '-0.1' })).toBeNull();
    expect(parseAnchorSelection({ ...valid, channel: '-1' })).toBeNull();
    expect(parseAnchorSelection({ ...valid, channel: '1.5' })).toBeNull();
    expect(parseAnchorSelection({ ...valid, maxOffsetFrames: '-1' })).toBeNull();
    expect(parseAnchorSelection({ ...valid, maxOffsetFrames: '2.5' })).toBeNull();
  });

  it('非法提示文案存在', () => {
    expect(INVALID_ANCHOR_NOTICE).toContain('锚点输入非法');
  });
});

describe('能量与归一化互相关', () => {
  it('rms：静音为 0，满幅为 1', () => {
    expect(rms(new Float32Array([0, 0, 0, 0]), 0, 4)).toBe(0);
    expect(rms(new Float32Array([1, -1, 1, -1]), 0, 4)).toBeCloseTo(1, 10);
    expect(rms(new Float32Array([0, 0.5, 0.5, 0]), 1, 2)).toBeCloseTo(0.5, 10);
  });

  it('长度非法返回 0', () => {
    expect(rms(new Float32Array([1]), 0, 0)).toBe(0);
  });

  it('相同窗口 NCC 为 1；反相为 -1', () => {
    const a = pseudoNoise(32);
    expect(normalizedCrossCorrelation(a, 0, a, 0, 32)).toBeCloseTo(1, 10);
    const neg = a.map((v) => -v);
    expect(normalizedCrossCorrelation(a, 0, neg, 0, 32)).toBeCloseTo(-1, 10);
  });

  it('NCC 与整体音量、直流偏置无关（局部归一化）', () => {
    const a = pseudoNoise(32);
    const scaled = a.map((v) => v * 0.3 + 0.4);
    expect(normalizedCrossCorrelation(a, 0, scaled, 0, 32)).toBeCloseTo(1, 8);
  });

  it('零方差窗口（常量/静音）返回 NaN，不得产生有效相关度', () => {
    const a = new Float32Array(32).fill(0.5);
    const b = new Float32Array(32).fill(0.7);
    expect(
      normalizedCrossCorrelation(a, 0, b, 0, 32)
    ).toBeNaN();
    const zero = new Float32Array(32);
    expect(normalizedCrossCorrelation(zero, 0, zero, 0, 32)).toBeNaN();
  });
});

describe('唯一裁决顺序（相关度 → 绝对偏移 → 正号）', () => {
  it('最高相关度胜出', () => {
    expect(
      chooseBestLag([
        { lag: 0, score: 0.9, overlapFrames: 4 },
        { lag: 2, score: 0.95, overlapFrames: 4 }
      ])?.lag
    ).toBe(2);
  });

  it('相关度相同：最小绝对偏移胜出', () => {
    const winner = chooseBestLag([
      { lag: -8, score: 1, overlapFrames: 4 },
      { lag: 4, score: 1, overlapFrames: 4 },
      { lag: 8, score: 1, overlapFrames: 4 }
    ]);
    expect(winner?.lag).toBe(4);
  });

  it('相关度相同、绝对偏移相同：正偏移胜出（+8 胜过 -8）', () => {
    const winner = chooseBestLag([
      { lag: -8, score: 1, overlapFrames: 4 },
      { lag: 8, score: 1, overlapFrames: 4 }
    ]);
    expect(winner?.lag).toBe(8);
  });

  it('0 偏移在比较中天然最小绝对值', () => {
    const winner = chooseBestLag([
      { lag: -1, score: 1, overlapFrames: 4 },
      { lag: 0, score: 1, overlapFrames: 4 },
      { lag: 1, score: 1, overlapFrames: 4 }
    ]);
    expect(winner?.lag).toBe(0);
  });

  it('NaN 候选全部跳过；空数组返回 null', () => {
    expect(
      chooseBestLag([
        { lag: 0, score: NaN, overlapFrames: 4 },
        { lag: 1, score: NaN, overlapFrames: 4 }
      ])
    ).toBeNull();
    expect(chooseBestLag([])).toBeNull();
  });

  it('偏移符号标记', () => {
    expect(offsetSign(0)).toBe('0');
    expect(offsetSign(3)).toBe('+');
    expect(offsetSign(-3)).toBe('-');
  });
});

describe('锚点对齐（合成移位 PCM）', () => {
  it('返工整体晚 +12 帧：唯一偏移 +12，NCC≈1，符号为正', () => {
    const base = pseudoNoise(120);
    const { rework } = shiftedPair(base, 12, 140);
    const baseline = scan('b.wav', [base]);
    const reworkScan = scan('r.wav', [rework]);
    const result = findBestAlignment({
      baseline,
      rework: reworkScan,
      selection: selection({
        anchorStartSeconds: 0.03,
        anchorDurationSeconds: 0.05
      })
    });
    expect(result.status).toBe('aligned');
    if (result.status !== 'aligned') throw new Error('应当对齐成功');
    expect(result.offsetFrames).toBe(12);
    expect(result.sign).toBe('+');
    expect(result.bestScore).toBeCloseTo(1, 9);
    expect(result.anchorRms).toBeGreaterThanOrEqual(MIN_ANCHOR_RMS);
    expect(result.anchorStartFrame).toBe(30);
    expect(result.anchorFrameCount).toBe(50);
  });

  it('返工整体早 12 帧（shift=-12，前缀补零）：唯一偏移 -12，符号为负', () => {
    const base = pseudoNoise(120);
    const { rework } = shiftedPair(base, -12, 120);
    const result = findBestAlignment({
      baseline: scan('b.wav', [base]),
      rework: scan('r.wav', [rework]),
      selection: selection({ anchorStartSeconds: 0.03, anchorDurationSeconds: 0.05 })
    });
    expect(result.status).toBe('aligned');
    if (result.status !== 'aligned') throw new Error('应当对齐成功');
    expect(result.offsetFrames).toBe(-12);
    expect(result.sign).toBe('-');
    expect(result.bestScore).toBeCloseTo(1, 9);
  });

  it('正号裁决：±16 两处匹配严格同分、中间滞后不同分时，正偏移胜出', () => {
    // 32 帧锚点 = 8 帧静音边垫 + 16 帧非对称噪声 P + 8 帧静音边垫（基线帧 8..39）。
    // 锚点 P 位于 base[24..39]。返工只放两份 P：
    //   rework[8..23]  = P → 对应 d = 24 - 8  = -16；
    //   rework[40..55] = P → 对应 d = 40 - 24 = +16。
    // ±16 窗口完整覆盖各自一份 P（两侧静音垫完全一致）→ NCC 严格同为 1；
    // 中间滞后（含 0）窗口只盖住 P 的一部分并混入静音 → NCC < 1。
    // 平局按【最高相关度 → 最小绝对偏移（相同）→ 偏移为正】落定 +16。
    const P = pseudoNoise(16, 11);
    const base = new Float32Array(64);
    P.forEach((v, i) => {
      base[24 + i] = v;
    });
    const rework = new Float32Array(64);
    P.forEach((v, i) => {
      rework[8 + i] = v; // d = -16
      rework[40 + i] = v; // d = +16
    });
    const result = findBestAlignment({
      baseline: scan('b.wav', [base]),
      rework: scan('r.wav', [rework]),
      selection: selection({
        anchorStartSeconds: 0.008,
        anchorDurationSeconds: 0.032,
        maxOffsetFrames: 20
      })
    });
    expect(result.status).toBe('aligned');
    if (result.status !== 'aligned') throw new Error('应当对齐成功');
    expect(result.offsetFrames).toBe(16);
    expect(result.sign).toBe('+');
    expect(result.bestScore).toBeCloseTo(1, 9);
  });

  it('静音锚点：weak-anchor，不强行对齐', () => {
    const base = new Float32Array(120);
    const rework = new Float32Array(120);
    const result = findBestAlignment({
      baseline: scan('b.wav', [base]),
      rework: scan('r.wav', [rework]),
      selection: selection({ anchorStartSeconds: 0.02, anchorDurationSeconds: 0.04 })
    });
    expect(result.status).toBe('failed');
    expect(result).toMatchObject({ status: 'failed', reason: 'weak-anchor' });
    if (result.status === 'failed') {
      expect(result.anchorRms).toBe(0);
      expect(result.message).toContain('能量不足');
    }
  });

  it('低能量锚点（低于 RMS 阈值）同样 weak-anchor', () => {
    const base = new Float32Array(120).fill(0.001);
    const result = findBestAlignment({
      baseline: scan('b.wav', [base]),
      rework: scan('r.wav', [new Float32Array(120)]),
      selection: selection()
    });
    expect(result).toMatchObject({ status: 'failed', reason: 'weak-anchor' });
  });

  it('锚点短于最少帧数：invalid-anchor', () => {
    const base = pseudoNoise(120);
    const result = findBestAlignment({
      baseline: scan('b.wav', [base]),
      rework: scan('r.wav', [base.slice()]),
      selection: selection({ anchorDurationSeconds: 0.01 }) // 10 帧 < 16
    });
    expect(result).toMatchObject({ status: 'failed', reason: 'invalid-anchor' });
    expect(MIN_ANCHOR_FRAMES).toBe(16);
  });

  it('锚点起点/终点超出基线：invalid-anchor', () => {
    const base = pseudoNoise(120);
    const other = scan('r.wav', [pseudoNoise(120)]);
    const startOut = findBestAlignment({
      baseline: scan('b.wav', [base]),
      rework: other,
      selection: selection({ anchorStartSeconds: 0.2 })
    });
    expect(startOut).toMatchObject({
      status: 'failed',
      reason: 'invalid-anchor'
    });
    const endOut = findBestAlignment({
      baseline: scan('b.wav', [base]),
      rework: other,
      selection: selection({ anchorStartSeconds: 0.1, anchorDurationSeconds: 0.05 })
    });
    expect(endOut).toMatchObject({ status: 'failed', reason: 'invalid-anchor' });
  });

  it('声道序号越界：invalid-anchor', () => {
    const base = pseudoNoise(120);
    const result = findBestAlignment({
      baseline: scan('b.wav', [base]),
      rework: scan('r.wav', [base.slice()]),
      selection: selection({ channel: 1 })
    });
    expect(result).toMatchObject({ status: 'failed', reason: 'invalid-anchor' });
  });

  it('采样率或声道数不同：format-mismatch', () => {
    const base = pseudoNoise(120);
    const rateMismatch = findBestAlignment({
      baseline: scan('b.wav', [base], SR),
      rework: scan('r.wav', [base.slice()], 2000),
      selection: selection()
    });
    expect(rateMismatch).toMatchObject({
      status: 'failed',
      reason: 'format-mismatch'
    });
    const channelMismatch = findBestAlignment({
      baseline: scan('b.wav', [base, base.slice()], SR),
      rework: scan('r.wav', [base.slice()], SR),
      selection: selection()
    });
    expect(channelMismatch).toMatchObject({
      status: 'failed',
      reason: 'format-mismatch'
    });
  });

  it('限定偏移范围内锚点无法完整落入返工：no-overlap', () => {
    // 基线 120 帧，锚点在末端帧 100..119（20 帧）；返工只有 110 帧，
    // 内容为基线整体晚 30 帧（rework[30..109]=base[0..79]），锚点内容根本不在返工中。
    // ±5 内任意候选窗口起点 95..105，加 20 帧均越过返工末端 110 → 无候选。
    const base = pseudoNoise(120, 23);
    const rework = new Float32Array(110);
    for (let f = 0; f < 80; f++) rework[f + 30] = base[f]!;
    const result = findBestAlignment({
      baseline: scan('b.wav', [base]),
      rework: scan('r.wav', [rework]),
      selection: selection({
        anchorStartSeconds: 0.1,
        anchorDurationSeconds: 0.02,
        maxOffsetFrames: 5
      })
    });
    expect(result).toMatchObject({ status: 'failed', reason: 'no-overlap' });
  });

  it('候选窗口全部零方差（返工对应区域常量）：no-overlap', () => {
    const base = pseudoNoise(120);
    const result = findBestAlignment({
      baseline: scan('b.wav', [base]),
      rework: scan('r.wav', [new Float32Array(120).fill(0.2)]),
      selection: selection({ maxOffsetFrames: 2 })
    });
    expect(result).toMatchObject({ status: 'failed', reason: 'no-overlap' });
  });
});

describe('真实重叠区', () => {
  it('返工更长、正偏移：重叠区为 [0, baseFrames)', () => {
    expect(alignedOverlapFrames(100, 120, 20)).toEqual({
      startFrame: 0,
      endExclusive: 100
    });
  });

  it('负偏移：重叠区起点为 -d', () => {
    expect(alignedOverlapFrames(100, 100, -20)).toEqual({
      startFrame: 20,
      endExclusive: 100
    });
  });

  it('返工较短：正偏移时重叠区在返工末端收束', () => {
    expect(alignedOverlapFrames(100, 60, 30)).toEqual({
      startFrame: 0,
      endExclusive: 30
    });
  });

  it('无真实重叠返回 null', () => {
    expect(alignedOverlapFrames(10, 10, 20)).toBeNull();
    expect(alignedOverlapFrames(10, 10, -20)).toBeNull();
  });

  it('坐标互逆映射（秒）', () => {
    expect(baselineSecondsToRework(1, 20, 1000)).toBe(1.02);
    expect(reworkSecondsToBaseline(1.02, 20, 1000)).toBe(1);
    expect(baselineSecondsToRework(1, -20, 1000)).toBe(0.98);
  });
});

/**
 * 逐帧预言机：与实现的事件扫描无关。
 * 对重叠区内且两侧文件物理覆盖的帧按集合判 FIXED/NEW/BOTH；
 * 任一侧未物理覆盖（含越过较短文件末端）判 BASELINE_ONLY/REWORK_ONLY（不可比较）。
 */
function oracleReworkDiff(
  baseline: Array<[number, number]>,
  reworkLocal: Array<[number, number]>,
  offset: number,
  overlap: [number, number],
  baseFrames: number,
  reworkFrames: number
): Array<[number, number, string]> {
  const globalRework = reworkLocal.map(
    ([s, e]) => [s - offset, e - offset] as [number, number]
  );
  const all = [
    ...baseline,
    ...globalRework,
    [overlap[0], overlap[1] - 1] as [number, number]
  ];
  const lo = Math.min(...all.map(([s]) => s));
  const hi = Math.max(...all.map(([, e]) => e));
  const out: Array<[number, number, string]> = [];
  for (let f = lo; f <= hi; f++) {
    const inB = baseline.some(([s, e]) => s <= f && f <= e);
    const inR = globalRework.some(([s, e]) => s <= f && f <= e);
    if (!inB && !inR) continue;
    const inO = overlap[0] <= f && f < overlap[1];
    const coveredB = f >= 0 && f < baseFrames;
    const coveredR = f + offset >= 0 && f + offset < reworkFrames;
    let kind: string;
    if (inO && coveredB && coveredR) {
      kind = inB ? (inR ? 'BOTH' : 'FIXED') : 'NEW';
    } else {
      kind = inB ? 'BASELINE_ONLY' : 'REWORK_ONLY';
    }
    const last = out[out.length - 1];
    if (last && last[2] === kind && last[1] === f - 1) last[1] = f;
    else out.push([f, f, kind]);
  }
  return out;
}

describe('返工差异切片（逐帧预言机）', () => {
  const run = (
    baselineSegs: Array<[number, number]>,
    reworkSegs: Array<[number, number]>,
    offset: number,
    baseFrames = 100,
    reworkFrames = 100
  ) => {
    const overlap = alignedOverlapFrames(baseFrames, reworkFrames, offset)!;
    const result = diffChannelRework({
      channel: 0,
      baseline: baselineSegs.map(([s, e]) => ({
        startFrame: s,
        endFrame: e,
        startSeconds: s / SR,
        endSeconds: (e + 1) / SR,
        durationSeconds: (e - s + 1) / SR,
        startMs: s,
        endMs: e + 1,
        durationMs: e - s + 1
      })),
      rework: reworkSegs.map(([s, e]) => ({
        startFrame: s,
        endFrame: e,
        startSeconds: s / SR,
        endSeconds: (e + 1) / SR,
        durationSeconds: (e - s + 1) / SR,
        startMs: s,
        endMs: e + 1,
        durationMs: e - s + 1
      })),
      sampleRate: SR,
      baselineFrames: baseFrames,
      reworkFrames,
      overlapStartFrame: overlap.startFrame,
      overlapEndExclusive: overlap.endExclusive,
      offsetFrames: offset
    });
    const actual = result.segments.map(
      (s) => [s.startFrame, s.endFrame, s.kind] as [number, number, string]
    );
    expect(actual).toEqual(
      oracleReworkDiff(baselineSegs, reworkSegs, offset, [
        overlap.startFrame,
        overlap.endExclusive
      ], baseFrames, reworkFrames)
    );
    return result;
  };

  it('同位置削波（含偏移平移后重叠）：BOTH', () => {
    // 基线段 [20..24]，返工本地段 [30..34]，偏移 +10 → 全局同为 [20..24]
    const result = run([[20, 24]], [[30, 34]], 10);
    expect(result.bothCount).toBe(1);
    expect(result.fixedCount).toBe(0);
    expect(result.newCount).toBe(0);
  });

  it('返工修复了重叠区基线段：FIXED，且返工尾部独有区域不可比较', () => {
    // 基线 100 帧、返工 110 帧、偏移 +10 → 重叠 [0,100)
    // 基线段 [20..24] 在重叠区内，返工无段 → FIXED
    // 返工全局独有区域 [100..109] 无段，不产生片段
    const result = run([[20, 24]], [], 10, 100, 110);
    expect(result.fixedCount).toBe(1);
    expect(result.segments[0]).toMatchObject({
      startFrame: 20,
      endFrame: 24,
      kind: 'FIXED'
    });
  });

  it('返工在重叠区新引入削波：NEW', () => {
    const result = run([], [[30, 34]], 10, 100, 110);
    expect(result.newCount).toBe(1);
    expect(result.segments[0]).toMatchObject({
      startFrame: 20,
      endFrame: 24,
      kind: 'NEW'
    });
  });

  it('部分相交：FIXED / BOTH / NEW 依次切分', () => {
    const result = run([[20, 26]], [[32, 38]], 10, 100, 110);
    expect(
      result.segments.map((s) => [s.startFrame, s.endFrame, s.kind])
    ).toEqual([
      [20, 21, 'FIXED'],
      [22, 26, 'BOTH'],
      [27, 28, 'NEW']
    ]);
  });

  it('未覆盖区域：基线独有帧为 BASELINE_ONLY，不计入 FIXED', () => {
    // 偏移 +10、返工仅 40 帧：物理覆盖交集 [0,30)（重叠区声明同此）。
    // 基线段 [25..40]：[25..29] 两侧物理覆盖且仅基线 → FIXED；
    // [30..40] 返工未覆盖（已越过返工末端）→ BASELINE_ONLY（不可比较）。
    const result = run([[25, 40]], [], 10, 100, 40);
    expect(
      result.segments.map((s) => [s.startFrame, s.endFrame, s.kind])
    ).toEqual([
      [25, 29, 'FIXED'],
      [30, 40, 'BASELINE_ONLY']
    ]);
    expect(result.fixedCount).toBe(1);
    expect(result.baselineOnlyCount).toBe(1);
    expect(result.incomparableFrames).toBe(11);
  });

  it('负偏移：返工头部段经平移落入重叠区判 NEW（起点恰为重叠边界）', () => {
    // 偏移 -10、同为 100 帧 → 重叠 [10,100)
    // 返工本地 [0..19] → 全局 [10..29]，全在重叠区内，仅返工 → NEW
    const result = run([], [[0, 19]], -10, 100, 100);
    expect(result.segments.map((s) => [s.startFrame, s.endFrame, s.kind])).toEqual([
      [10, 29, 'NEW']
    ]);
    expect(result.reworkOnlyCount).toBe(0);
  });

  it('REWORK_ONLY：正偏移下返工尾部段落在重叠区外', () => {
    // 偏移 +10、基线 100、返工 120 → 重叠 [0,100)
    // 返工本地段 [105..109] → 全局 [95..99]（FIXED 区候选，但这里无基线段 → NEW）
    // 返工本地段 [110..114] → 全局 [100..104]，基线未覆盖 → REWORK_ONLY
    const result = run([], [[105, 114]], 10, 100, 120);
    expect(
      result.segments.map((s) => [s.startFrame, s.endFrame, s.kind])
    ).toEqual([
      [95, 99, 'NEW'],
      [100, 104, 'REWORK_ONLY']
    ]);
    expect(result.newCount).toBe(1);
    expect(result.reworkOnlyCount).toBe(1);
    expect(result.incomparableFrames).toBe(5);
  });

  it('片段携带两侧文件坐标，未覆盖一侧为 null', () => {
    const result = run([[25, 40]], [], 10, 100, 40);
    const fixed = result.segments.find((s) => s.kind === 'FIXED')!;
    expect(fixed.baselineStartFrame).toBe(25);
    expect(fixed.baselineEndFrame).toBe(29);
    expect(fixed.reworkStartFrame).toBe(35); // 全局 + 偏移
    expect(fixed.reworkEndFrame).toBe(39);
    const only = result.segments.find((s) => s.kind === 'BASELINE_ONLY')!;
    expect(only.baselineStartFrame).toBe(30);
    expect(only.reworkStartFrame).toBeNull();
    expect(only.reworkStartMs).toBeNull();
  });

  it('两套均空：无片段、无不可比较帧', () => {
    const result = run([], [], 10, 100, 110);
    expect(result.segments).toEqual([]);
    expect(result.incomparableFrames).toBe(0);
  });

  it('标记文案覆盖五种成员集合', () => {
    expect(REWORK_DIFF_KIND_LABELS.FIXED).toContain('已修复');
    expect(REWORK_DIFF_KIND_LABELS.NEW).toContain('新增');
    expect(REWORK_DIFF_KIND_LABELS.BOTH).toContain('共有');
    expect(REWORK_DIFF_KIND_LABELS.BASELINE_ONLY).toContain('不可比较');
    expect(REWORK_DIFF_KIND_LABELS.REWORK_ONLY).toContain('不可比较');
  });
});

describe('完整返工对照 buildReworkComparison', () => {
  /** 在指定帧区间写入满幅削波（可能再整体移位） */
  function pcmWithClips(
    frames: number,
    clips: Array<[number, number]>,
    shift = 0,
    seedPcm?: Float32Array
  ): Float32Array {
    const data = seedPcm
      ? seedPcm.slice(0, Math.max(seedPcm.length, frames))
      : new Float32Array(frames);
    if (data.length < frames) {
      const grown = new Float32Array(frames);
      grown.set(data);
    }
    for (const [s, e] of clips) {
      for (let f = s + shift; f <= e + shift; f++) {
        if (f >= 0 && f < frames) data[f] = 1;
      }
    }
    return data;
  }

  it('移位错位被识别为 BOTH：差异仅来自几十帧起点差，无真实质量变化', () => {
    // 带噪声的“录音”，其中一段 5 帧满幅；返工整体晚 30 帧，削波随内容平移
    const baseContent = pseudoNoise(200, 3);
    const base = pcmWithClips(200, [[60, 64]], 0, baseContent);
    const reworkSeeds = new Float32Array(230);
    for (let f = 0; f < baseContent.length; f++) {
      if (f + 30 < reworkSeeds.length) reworkSeeds[f + 30] = baseContent[f]!;
    }
    const rework = pcmWithClips(230, [[60, 64]], 30, reworkSeeds);

    const baseline = scan('b.wav', [base]);
    const reworkScan = scan('r.wav', [rework]);
    const aligned = findBestAlignment({
      baseline,
      rework: reworkScan,
      selection: selection({
        anchorStartSeconds: 0.01,
        anchorDurationSeconds: 0.08,
        maxOffsetFrames: 60
      })
    });
    expect(aligned.status).toBe('aligned');
    if (aligned.status !== 'aligned') throw new Error('必须对齐');
    const comparison = buildReworkComparison(baseline, reworkScan, aligned);
    expect(comparison.alignment.offsetFrames).toBe(30);
    expect(comparison.hasRealDifference).toBe(false);
    expect(comparison.fixedCount).toBe(0);
    expect(comparison.newCount).toBe(0);
    expect(comparison.bothCount).toBe(1);
    expect(comparison.overlapFrameCount).toBe(200);
  });

  it('重叠区基线段在返工中消失：FIXED，确认为真实修复', () => {
    const base = pcmWithClips(200, [[60, 64]], 0, pseudoNoise(200, 5));
    // 返工同位置不再满幅（保留噪声），仅整体晚 5 帧
    const reworkSeeds = new Float32Array(210);
    const noise = pseudoNoise(200, 5);
    for (let f = 0; f < noise.length; f++) reworkSeeds[f + 5] = noise[f]!;
    const rework = reworkSeeds; // 不写入削波

    const baseline = scan('b.wav', [base]);
    const reworkScan = scan('r.wav', [rework]);
    const aligned = findBestAlignment({
      baseline,
      rework: reworkScan,
      selection: selection({
        anchorStartSeconds: 0.01,
        anchorDurationSeconds: 0.08,
        maxOffsetFrames: 20
      })
    });
    if (aligned.status !== 'aligned') throw new Error('必须对齐');
    expect(aligned.offsetFrames).toBe(5);
    const comparison = buildReworkComparison(baseline, reworkScan, aligned);
    expect(comparison.hasRealDifference).toBe(true);
    expect(comparison.fixedCount).toBe(1);
    expect(comparison.newCount).toBe(0);
  });

  it('多声道：左声道修复、右声道新增，逐声道独立计数与着色数组', () => {
    // 偏移统一为 -8（返工早 8 帧）：rework[f] = baseline[f + 8]
    const shiftMinus8 = (src: Float32Array, frames: number): Float32Array => {
      const out = new Float32Array(frames);
      for (let r = 0; r < frames; r++) {
        const b = r + 8;
        if (b < src.length) out[r] = src[b]!;
      }
      return out;
    };
    const leftNoise = pseudoNoise(160, 9);
    const rightNoise = pseudoNoise(160, 13);
    const leftBase = pcmWithClips(160, [[40, 44]], 0, leftNoise);
    const rightBase = rightNoise; // 基线右声道干净
    const leftRework = shiftMinus8(leftBase, 160);
    // 左返工本地 [32..36] 对应基线 [40..44]：抹掉削波（换成低幅噪声）
    for (let f = 32; f <= 36; f++) leftRework[f] = 0.05 * (f % 3);
    const rightRework = shiftMinus8(rightBase, 160);
    // 右返工本地 [60..64] 新增削波 → 全局 68..72
    for (let f = 60; f <= 64; f++) rightRework[f] = 1;

    const baseline = scan('stereo.wav', [leftBase, rightBase]);
    const reworkScan = scan('stereo-r.wav', [leftRework, rightRework]);
    const aligned = findBestAlignment({
      baseline,
      rework: reworkScan,
      selection: selection({
        channel: 0,
        anchorStartSeconds: 0.02,
        anchorDurationSeconds: 0.08,
        maxOffsetFrames: 20
      })
    });
    if (aligned.status !== 'aligned') throw new Error('必须对齐');
    expect(aligned.channel).toBe(0);
    expect(aligned.offsetFrames).toBe(-8);
    const comparison = buildReworkComparison(baseline, reworkScan, aligned);
    expect(comparison.channels).toHaveLength(2);
    // 左：基线 [40..44] 在重叠区且返工消失 → FIXED
    const leftKinds = comparison.channels[0]!.segments.map((s) => s.kind);
    expect(leftKinds).toContain('FIXED');
    expect(leftKinds).not.toContain('NEW');
    // 右：返工本地 [60..64] → 全局 [68..72]，仅返工 → NEW
    const rightSegs = comparison.channels[1]!.segments;
    expect(rightSegs.map((s) => s.kind)).toEqual(['NEW']);
    expect(rightSegs[0]).toMatchObject({ startFrame: 68, endFrame: 72 });

    // 双波形标记数组：同一片段数组按各自坐标映射
    const leftMarks = baselineWaveMarks(comparison.channels[0]!.segments);
    expect(leftMarks.some((m) => m.kind === 'FIXED')).toBe(true);
    const rightReworkMarks = reworkWaveMarks(
      comparison.channels[1]!.segments
    );
    expect(rightReworkMarks.some((m) => m.kind === 'NEW')).toBe(true);
  });

  it('规格不一致时 buildReworkComparison 抛错', () => {
    const base = scan('b.wav', [pseudoNoise(40)]);
    const otherRate = buildScanResult('r.wav', [pseudoNoise(40)], 2000);
    const aligned = {
      status: 'aligned' as const,
      offsetFrames: 0,
      sign: '0' as const,
      bestScore: 1,
      candidateCount: 1,
      channel: 0,
      anchorStartFrame: 0,
      anchorFrameCount: 16,
      anchorRms: 0.5,
      maxOffsetFrames: 0
    };
    expect(() => buildReworkComparison(base, otherRate, aligned)).toThrow(
      RangeError
    );
  });

  it('双波形标记：基线/返工标记分别映射，未覆盖片段不出现在对应一侧', () => {
    const base = pcmWithClips(100, [[25, 40]], 0, pseudoNoise(100, 17));
    // 返工 40 帧常量 0.3：锚点可对齐的候选窗口全部零方差 → no-overlap，
    // 因此对照用手工偏移（+10）在纯函数层构造，只验证标记映射。
    const rework = new Float32Array(40).fill(0.3);
    const baseline = scan('b.wav', [base]);
    scan('r.wav', [rework]);
    const aligned = findBestAlignment({
      baseline,
      rework: scan('r.wav', [new Float32Array(40).fill(0.3)]),
      selection: selection({ anchorStartSeconds: 0, maxOffsetFrames: 10 })
    });
    expect(aligned.status).toBe('failed');
    const overlap = alignedOverlapFrames(100, 40, 10)!;
    const diff = diffChannelRework({
      channel: 0,
      baseline: baseline.channels[0]!.segments,
      rework: [],
      sampleRate: SR,
      baselineFrames: 100,
      reworkFrames: 40,
      overlapStartFrame: overlap.startFrame,
      overlapEndExclusive: overlap.endExclusive,
      offsetFrames: 10
    });
    const bMarks = baselineWaveMarks(diff.segments);
    const rMarks = reworkWaveMarks(diff.segments);
    expect(bMarks).toHaveLength(2); // FIXED + BASELINE_ONLY
    // 返工侧：FIXED 片段有返工坐标；BASELINE_ONLY 片段被剔除
    expect(rMarks).toHaveLength(1);
    expect(rMarks[0]!.kind).toBe('FIXED');
  });
});
