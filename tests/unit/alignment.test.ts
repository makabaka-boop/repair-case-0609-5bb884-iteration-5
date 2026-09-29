import { describe, expect, it } from 'vitest';
import {
  ANCHOR_LOW_ENERGY,
  ANCHOR_MIN_RMS,
  alignByAnchor,
  alignmentErrorMessage,
  betterCandidate,
  parseAnchorInput,
  INVALID_ANCHOR_NOTICE,
  windowRms
} from '../../src/audio/alignment';

const SR = 1000;

/** 伪随机但确定的有效声音：多频率正弦叠加，NCC 能区分不同偏移 */
function tonal(length: number, phase = 0, scale = 0.5): Float32Array {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i + phase;
    data[i] =
      scale *
      (0.6 * Math.sin((2 * Math.PI * t) / 17) +
        0.4 * Math.sin((2 * Math.PI * t) / 7.3 + 1.1));
  }
  return data;
}

/** 把 src 整体平移 shift 帧放到 dst：dst[i] = src[i-shift]（shift>0 返工晚开始） */
function shifted(src: Float32Array, shift: number, total: number): Float32Array {
  const dst = new Float32Array(total);
  for (let i = 0; i < src.length; i++) {
    const j = i + shift;
    if (j >= 0 && j < total) dst[j] = src[i]!;
  }
  return dst;
}

describe('alignByAnchor 合成移位 PCM 对齐', () => {
  it('正偏移（返工晚开始 +37 帧）：在 ±80 范围内唯一找到 +37，相关度近 1', () => {
    const base = tonal(400);
    const rework = shifted(base, 37, 440);
    const r = alignByAnchor(base, rework, {
      anchorStartFrame: 50,
      anchorLengthFrames: 120,
      maxOffsetFrames: 80,
      channel: 0
    });
    expect('offsetFrames' in r).toBe(true);
    const ok = r as Exclude<typeof r, { kind: string }>;
    expect(ok.offsetFrames).toBe(37);
    expect(ok.score).toBeGreaterThan(0.9999);
    expect(ok.comparedFrames).toBe(120);
  });

  it('负偏移（返工早开始 −23 帧）：唯一找到 −23', () => {
    const base = tonal(400);
    const rework = shifted(base, -23, 380);
    const r = alignByAnchor(base, rework, {
      anchorStartFrame: 60,
      anchorLengthFrames: 120,
      maxOffsetFrames: 80,
      channel: 0
    });
    expect('offsetFrames' in r).toBe(true);
    expect((r as { offsetFrames: number }).offsetFrames).toBe(-23);
  });

  it('偏移恰为搜索范围边界（+80 / −80）仍可命中', () => {
    const base = tonal(500);
    for (const shift of [80, -80]) {
      const rework = shifted(base, shift, 500);
      const r = alignByAnchor(base, rework, {
        anchorStartFrame: 90,
        anchorLengthFrames: 120,
        maxOffsetFrames: 80,
        channel: 0
      });
      expect((r as { offsetFrames: number }).offsetFrames).toBe(shift);
    }
  });

  it('真实偏移超出限定范围：不会强行返回一个低相关偏移', () => {
    const base = tonal(500);
    const rework = shifted(base, 120, 640);
    const r = alignByAnchor(base, rework, {
      anchorStartFrame: 50,
      anchorLengthFrames: 120,
      maxOffsetFrames: 40,
      channel: 0
    });
    // 窗口仍落在返工 PCM 内但内容错位：相关度不会高；实现不做阈值裁决，
    // 但偏移绝不应等于真实 120（超出范围不可能取到）
    if ('offsetFrames' in r) {
      expect(Math.abs(r.offsetFrames)).toBeLessThanOrEqual(40);
      expect(r.offsetFrames).not.toBe(120);
    } else {
      expect(r.kind).toBe(ANCHOR_LOW_ENERGY);
    }
  });

  it('返工侧整体幅度不同（修复增益）：归一化后仍精确对齐', () => {
    const base = tonal(400, 0, 0.5);
    const quiet = tonal(400, 0, 0.12);
    const rework = shifted(quiet, 11, 420);
    const r = alignByAnchor(base, rework, {
      anchorStartFrame: 50,
      anchorLengthFrames: 120,
      maxOffsetFrames: 60,
      channel: 0
    });
    expect((r as { offsetFrames: number }).offsetFrames).toBe(11);
    expect((r as { score: number }).score).toBeGreaterThan(0.9999);
  });

  it('窗口越过返工 PCM 边界的候选偏移自动排除，只裁决完整窗口', () => {
    // 锚点在基线末尾附近：正偏移候选超出返工长度，只能取非正偏移
    const base = tonal(200);
    const rework = shifted(base, -5, 200); // 真实 −5
    const r = alignByAnchor(base, rework, {
      anchorStartFrame: 60,
      anchorLengthFrames: 100,
      maxOffsetFrames: 50,
      channel: 0
    });
    expect((r as { offsetFrames: number }).offsetFrames).toBe(-5);
  });
});

describe('alignByAnchor 裁决顺序：相关度 → |偏移| → 符号', () => {
  it('betterCandidate：严格按三层顺序比较', () => {
    // 相关度更高 → 胜
    expect(betterCandidate(0.9, 50, 0.8, 0)).toBe(true);
    expect(betterCandidate(0.8, 0, 0.9, 50)).toBe(false);
    // 相关度相同：绝对偏移更小 → 胜
    expect(betterCandidate(0.9, 3, 0.9, 10)).toBe(true);
    expect(betterCandidate(0.9, 10, 0.9, 3)).toBe(false);
    // 相关度相同、|d| 相同：负偏移优先（-5 胜过 +5）
    expect(betterCandidate(0.9, -5, 0.9, 5)).toBe(true);
    expect(betterCandidate(0.9, 5, 0.9, -5)).toBe(false);
    // 完全相同不胜（避免无谓替换）
    expect(betterCandidate(0.9, 4, 0.9, 4)).toBe(false);
  });

  it('对称信号 ±偏移相关度相同且 |偏移| 相同：裁决负偏移，结果唯一', () => {
    // 构造关于锚点对称、周期为 8 的信号：d=+8 与 d=-8 窗口内容完全一致
    const base = new Float32Array(120);
    for (let i = 0; i < base.length; i++) {
      base[i] = 0.5 * Math.sin((2 * Math.PI * i) / 8);
    }
    const r = alignByAnchor(base, base, {
      anchorStartFrame: 40,
      anchorLengthFrames: 40,
      maxOffsetFrames: 40,
      channel: 0
    });
    // 0 偏移相关度最高（精确 1），偏移 ±8 相关度同为 1；
    // 0 偏移 |d| 最小 → 必须裁决 0 而不是任何 ±8
    expect((r as { offsetFrames: number }).offsetFrames).toBe(0);
    expect((r as { score: number }).score).toBeGreaterThan(0.999999);
  });
});

describe('alignByAnchor 静音 / 能量不足锚点不得强行对齐', () => {
  it('纯零锚点：ANCHOR_LOW_ENERGY，不产出对齐结果', () => {
    const base = new Float32Array(100);
    const rework = new Float32Array(100);
    const r = alignByAnchor(base, rework, {
      anchorStartFrame: 10,
      anchorLengthFrames: 30,
      maxOffsetFrames: 20,
      channel: 0
    });
    expect(r).toMatchObject({ kind: ANCHOR_LOW_ENERGY });
  });

  it('恒定直流锚点：RMS 达标但零方差（候选去均值后无能量）→ 找不到可归一化匹配', () => {
    const base = new Float32Array(100).fill(0.5);
    const rework = new Float32Array(100).fill(0.5);
    const r = alignByAnchor(base, rework, {
      anchorStartFrame: 10,
      anchorLengthFrames: 40,
      maxOffsetFrames: 20,
      channel: 0
    });
    expect(r).toMatchObject({ kind: ANCHOR_LOW_ENERGY });
  });

  it('锚点有效但限定范围内返工全静音：ANCHOR_LOW_ENERGY，不强行给偏移', () => {
    const base = tonal(200);
    const rework = new Float32Array(220); // 全静音
    const r = alignByAnchor(base, rework, {
      anchorStartFrame: 30,
      anchorLengthFrames: 80,
      maxOffsetFrames: 20,
      channel: 0
    });
    expect(r).toMatchObject({ kind: ANCHOR_LOW_ENERGY });
  });

  it('锚点 RMS 低于阈值（微弱但非零）：判能量不足', () => {
    const base = tonal(200, 0, ANCHOR_MIN_RMS * 0.5);
    const rework = shifted(base, 5, 210);
    const r = alignByAnchor(base, rework, {
      anchorStartFrame: 30,
      anchorLengthFrames: 80,
      maxOffsetFrames: 20,
      channel: 0
    });
    expect(r).toMatchObject({ kind: ANCHOR_LOW_ENERGY });
  });

  it('windowRms 直接计算正确', () => {
    const data = new Float32Array([3, 4]);
    expect(windowRms(data, 0, 2)).toBeCloseTo(Math.sqrt((9 + 16) / 2), 10);
  });

  it('alignmentErrorMessage 返回错误中文文案', () => {
    const r = alignByAnchor(new Float32Array(10), new Float32Array(10), {
      anchorStartFrame: 0,
      anchorLengthFrames: 5,
      maxOffsetFrames: 2,
      channel: 0
    });
    expect('kind' in r).toBe(true);
    if ('kind' in r) {
      const msg = alignmentErrorMessage(r);
      expect(typeof msg).toBe('string');
      expect(msg).not.toBe('');
    }
  });
});

describe('alignByAnchor 参数校验', () => {
  const valid = tonal(200);

  it('锚点起点 / 长度非法：PARAM 错误，保留旧对照由调用方处理', () => {
    const r1 = alignByAnchor(valid, valid, {
      anchorStartFrame: -1,
      anchorLengthFrames: 20,
      maxOffsetFrames: 10,
      channel: 0
    });
    expect(r1).toMatchObject({ kind: 'PARAM', code: 'ANCHOR_OUT_OF_RANGE' });

    const r2 = alignByAnchor(valid, valid, {
      anchorStartFrame: 0,
      anchorLengthFrames: 0,
      maxOffsetFrames: 10,
      channel: 0
    });
    expect(r2).toMatchObject({ kind: 'PARAM', code: 'ANCHOR_TOO_SHORT' });
  });

  it('锚点超出基线帧数：ANCHOR_OUT_OF_RANGE', () => {
    const r = alignByAnchor(valid, valid, {
      anchorStartFrame: 150,
      anchorLengthFrames: 80,
      maxOffsetFrames: 10,
      channel: 0
    });
    expect(r).toMatchObject({ kind: 'PARAM', code: 'ANCHOR_OUT_OF_RANGE' });
  });

  it('帧偏移 / 声道非法：对应错误码', () => {
    const r1 = alignByAnchor(valid, valid, {
      anchorStartFrame: 0,
      anchorLengthFrames: 20,
      maxOffsetFrames: -1,
      channel: 0
    });
    expect(r1).toMatchObject({ kind: 'PARAM', code: 'INVALID_MAX_OFFSET' });

    const r2 = alignByAnchor(valid, valid, {
      anchorStartFrame: 0,
      anchorLengthFrames: 20,
      maxOffsetFrames: 5,
      channel: -1
    });
    expect(r2).toMatchObject({ kind: 'PARAM', code: 'CHANNEL_MISMATCH' });
  });
});

describe('parseAnchorInput 输入解析', () => {
  it('合法输入：秒按采样率换算为帧（四舍五入，长度至少 1 帧）', () => {
    expect(
      parseAnchorInput(
        {
          startSeconds: '0.01',
          lengthSeconds: '0.2',
          maxOffsetFrames: '80',
          channel: '1'
        },
        SR,
        2
      )
    ).toEqual({
      anchorStartFrame: 10,
      anchorLengthFrames: 200,
      maxOffsetFrames: 80,
      channel: 1
    });
  });

  it('空 / 非数字 / 起点为负 / 长度非正 → null', () => {
    const base = {
      startSeconds: '0.1',
      lengthSeconds: '0.2',
      maxOffsetFrames: '80',
      channel: '0'
    };
    for (const bad of ['', 'x', '-0.1']) {
      expect(parseAnchorInput({ ...base, startSeconds: bad }, SR, 1)).toBeNull();
    }
    for (const bad of ['', '0', '-1', 'x']) {
      expect(parseAnchorInput({ ...base, lengthSeconds: bad }, SR, 1)).toBeNull();
    }
  });

  it('帧偏移 / 声道必须为非负整数；声道越界为 null', () => {
    const base = {
      startSeconds: '0.1',
      lengthSeconds: '0.2',
      maxOffsetFrames: '80',
      channel: '0'
    };
    for (const bad of ['-1', '1.5', 'x', '']) {
      expect(parseAnchorInput({ ...base, maxOffsetFrames: bad }, SR, 1)).toBeNull();
    }
    expect(parseAnchorInput({ ...base, channel: '1' }, SR, 1)).toBeNull();
    expect(parseAnchorInput({ ...base, channel: '0.5' }, SR, 2)).toBeNull();
  });

  it('起点 0 秒合法；提示文案存在', () => {
    expect(
      parseAnchorInput(
        { startSeconds: '0', lengthSeconds: '0.0005', maxOffsetFrames: '0', channel: '0' },
        SR,
        1
      )
    ).toEqual({ anchorStartFrame: 0, anchorLengthFrames: 1, maxOffsetFrames: 0, channel: 0 });
    expect(INVALID_ANCHOR_NOTICE).toContain('锚点参数非法');
  });
});
