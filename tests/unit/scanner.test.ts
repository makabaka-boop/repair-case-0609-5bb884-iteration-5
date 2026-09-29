import { describe, expect, it } from 'vitest';
import {
  CLIP_THRESHOLD,
  MAX_MERGE_GAP,
  MIN_RUN_FRAMES,
  buildScanResult,
  isClipSample,
  scanChannel
} from '../../src/audio/scanner';

const SR = 1000;

function pcm(...samples: number[]): Float32Array {
  return Float32Array.from(samples);
}

/** 生成指定长度静音，再叠加各段 */
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

describe('阈值判定', () => {
  it('阈值常量符合规格', () => {
    expect(CLIP_THRESHOLD).toBe(0.999);
    expect(MIN_RUN_FRAMES).toBe(3);
    expect(MAX_MERGE_GAP).toBe(2);
  });

  it('绝对值大于等于 0.999 判定为削波帧（含负向）', () => {
    expect(isClipSample(0.999)).toBe(true);
    expect(isClipSample(-0.999)).toBe(true);
    expect(isClipSample(1)).toBe(true);
    expect(isClipSample(-1)).toBe(true);
  });

  it('绝对值小于 0.999（无论多接近）不判定为削波帧', () => {
    expect(isClipSample(0.998999)).toBe(false);
    expect(isClipSample(-0.9985)).toBe(false);
    expect(isClipSample(0)).toBe(false);
    expect(isClipSample(0.5)).toBe(false);
  });
});

describe('连续帧成段（至少 3 帧）', () => {
  it('1 帧尖峰不形成段', () => {
    const r = scanChannel(build(10, [{ start: 2, length: 1 }]), SR, 0);
    expect(r.segments).toHaveLength(0);
  });

  it('2 帧连续不形成段', () => {
    const r = scanChannel(build(10, [{ start: 2, length: 2 }]), SR, 0);
    expect(r.segments).toHaveLength(0);
  });

  it('恰好 3 帧形成段', () => {
    const r = scanChannel(build(10, [{ start: 2, length: 3 }]), SR, 0);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ startFrame: 2, endFrame: 4 });
  });

  it('负向饱和同样成段', () => {
    const r = scanChannel(build(10, [{ start: 0, length: 5, value: -1 }]), SR, 0);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ startFrame: 0, endFrame: 4 });
  });

  it('段可出现在录音末尾', () => {
    const r = scanChannel(build(8, [{ start: 5, length: 3 }]), SR, 0);
    expect(r.segments[0]).toMatchObject({ startFrame: 5, endFrame: 7 });
  });

  it('两段独立游程分别成段（间隔足够大）', () => {
    const r = scanChannel(
      build(30, [
        { start: 0, length: 4 },
        { start: 10, length: 4 }
      ]),
      SR,
      0
    );
    expect(r.segments).toHaveLength(2);
  });
});

describe('相邻段合并（间隔 ≤2 帧必须合并，≥3 帧不合并）', () => {
  it('间隔 2 帧必须合并', () => {
    // 游程 [0..2] 与 [5..7]，间隔帧 3、4 => 2 帧
    const r = scanChannel(
      build(8, [
        { start: 0, length: 3 },
        { start: 5, length: 3 }
      ]),
      SR,
      0
    );
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ startFrame: 0, endFrame: 7 });
  });

  it('间隔 1 帧必须合并', () => {
    const r = scanChannel(
      build(7, [
        { start: 0, length: 3 },
        { start: 4, length: 3 }
      ]),
      SR,
      0
    );
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ startFrame: 0, endFrame: 6 });
  });

  it('间隔 3 帧不得合并', () => {
    // 游程 [0..2] 与 [6..8]，间隔帧 3、4、5 => 3 帧
    const r = scanChannel(
      build(9, [
        { start: 0, length: 3 },
        { start: 6, length: 3 }
      ]),
      SR,
      0
    );
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]).toMatchObject({ startFrame: 0, endFrame: 2 });
    expect(r.segments[1]).toMatchObject({ startFrame: 6, endFrame: 8 });
  });

  it('不足 3 帧的尖峰不形成段，也不桥接两段（间隔按帧号差计为 3 帧）', () => {
    // [0..3] 长段，帧 5 单发（不成段），[7..10] 长段；
    // 相邻段间隔 = 7 - 3 - 1 = 3 帧（帧 4、5、6），>=3 不得合并。
    const r = scanChannel(
      build(11, [
        { start: 0, length: 4 },
        { start: 5, length: 1 },
        { start: 7, length: 4 }
      ]),
      SR,
      0
    );
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]).toMatchObject({ startFrame: 0, endFrame: 3 });
    expect(r.segments[1]).toMatchObject({ startFrame: 7, endFrame: 10 });
  });

  it('空数据不产生段', () => {
    const r = scanChannel(pcm(), SR, 0);
    expect(r.segments).toEqual([]);
    expect(r.totalClipSeconds).toBe(0);
  });
});

describe('声道汇总与总削波时长', () => {
  it('同一时刻双声道削波分别计入（时长加倍）', () => {
    // 两声道各 10 帧，采样率 10：帧 2..4 各有 3 帧削波 => 每声道 0.3 s
    const ch = build(10, [{ start: 2, length: 3 }]);
    const result = buildScanResult('stereo.wav', [ch, ch.slice()], 10);
    expect(result.hasClip).toBe(true);
    expect(result.channels).toHaveLength(2);
    expect(result.totalClipSeconds).toBeCloseTo(0.6, 10);
    expect(result.totalClipMs).toBe(600);
    expect(result.firstClip).toEqual({
      channel: 0,
      segment: expect.objectContaining({ startFrame: 2 })
    });
  });

  it('仅单声道削波时只该声道有段，首个异常指向该声道', () => {
    const clean = new Float32Array(12);
    const clipped = build(12, [{ start: 6, length: 4 }]);
    const result = buildScanResult('one.wav', [clean, clipped], 1000);
    expect(result.channels[0]!.segments).toHaveLength(0);
    expect(result.channels[1]!.segments).toHaveLength(1);
    expect(result.firstClip?.channel).toBe(1);
    expect(result.firstClip?.segment.startFrame).toBe(6);
  });

  it('无任何削波时结论为可交付数据（hasClip=false）', () => {
    const result = buildScanResult(
      'clean.wav',
      [new Float32Array(16), new Float32Array(16)],
      1000
    );
    expect(result.hasClip).toBe(false);
    expect(result.firstClip).toBeNull();
    expect(result.totalClipMs).toBe(0);
  });

  it('每声道合计毫秒为各段精确时长之和再取整', () => {
    // 采样率 3：3 帧段 = 1000 ms
    const r = scanChannel(build(6, [{ start: 0, length: 3 }]), 3, 0);
    expect(r.totalClipSeconds).toBeCloseTo(1, 10);
    expect(r.totalClipMs).toBe(1000);
  });

  it('非法采样率抛出 RangeError', () => {
    expect(() => scanChannel(pcm(1, 1, 1), 0, 0)).toThrow(RangeError);
  });
});
