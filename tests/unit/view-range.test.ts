import { describe, expect, it } from 'vitest';
import {
  INVALID_WINDOW_NOTICE,
  SHORT_RECORDING_NOTICE,
  fullTrackRange,
  localViewRange,
  parseWindowSeconds
} from '../../src/audio/view-range';

describe('整轨视图范围', () => {
  it('起止为 0 与录音时长', () => {
    expect(fullTrackRange(30)).toEqual({ startSeconds: 0, endSeconds: 30 });
    expect(fullTrackRange(0.0125)).toEqual({
      startSeconds: 0,
      endSeconds: 0.0125
    });
  });

  it('非法时长回退为 0', () => {
    expect(fullTrackRange(0)).toEqual({ startSeconds: 0, endSeconds: 0 });
    expect(fullTrackRange(-5)).toEqual({ startSeconds: 0, endSeconds: 0 });
    expect(fullTrackRange(NaN)).toEqual({ startSeconds: 0, endSeconds: 0 });
    expect(fullTrackRange(Infinity)).toEqual({ startSeconds: 0, endSeconds: 0 });
  });
});

describe('局部视窗：居中', () => {
  it('关注点位于中部时以其为中心、保持指定宽度', () => {
    expect(localViewRange(100, 10, 50)).toEqual({
      startSeconds: 45,
      endSeconds: 55
    });
  });

  it('小数宽度同样居中（30s 录音、6s 视窗、15s 处）', () => {
    const range = localViewRange(30, 6, 15);
    expect(range.startSeconds).toBeCloseTo(12, 10);
    expect(range.endSeconds).toBeCloseTo(18, 10);
    expect(range.endSeconds - range.startSeconds).toBeCloseTo(6, 10);
  });
});

describe('局部视窗：触及首尾只平移', () => {
  it('靠近开头平移到 [0, 宽度]，宽度不变', () => {
    expect(localViewRange(100, 10, 2)).toEqual({
      startSeconds: 0,
      endSeconds: 10
    });
    expect(localViewRange(100, 10, 0)).toEqual({
      startSeconds: 0,
      endSeconds: 10
    });
  });

  it('靠近结尾平移到 [时长 - 宽度, 时长]，宽度不变', () => {
    expect(localViewRange(100, 10, 98)).toEqual({
      startSeconds: 90,
      endSeconds: 100
    });
    expect(localViewRange(100, 10, 1000)).toEqual({
      startSeconds: 90,
      endSeconds: 100
    });
  });

  it('恰好半宽度处不再平移', () => {
    expect(localViewRange(100, 10, 5)).toEqual({
      startSeconds: 0,
      endSeconds: 10
    });
    expect(localViewRange(100, 10, 95)).toEqual({
      startSeconds: 90,
      endSeconds: 100
    });
  });
});

describe('局部视窗：录音不宽于视窗时回退整轨', () => {
  it('等长回退：视窗秒数等于录音时长', () => {
    expect(localViewRange(10, 10, 5)).toEqual({
      startSeconds: 0,
      endSeconds: 10
    });
  });

  it('短于回退：视窗秒数大于录音时长', () => {
    expect(localViewRange(8, 10, 4)).toEqual({ startSeconds: 0, endSeconds: 8 });
    expect(localViewRange(0.01, 10, 0.005)).toEqual({
      startSeconds: 0,
      endSeconds: 0.01
    });
  });
});

describe('局部视窗：非法参数防御', () => {
  it('非法视窗秒数回退整轨', () => {
    expect(localViewRange(30, 0, 10)).toEqual({ startSeconds: 0, endSeconds: 30 });
    expect(localViewRange(30, -2, 10)).toEqual({
      startSeconds: 0,
      endSeconds: 30
    });
    expect(localViewRange(30, NaN, 10)).toEqual({
      startSeconds: 0,
      endSeconds: 30
    });
  });

  it('非法关注点按 0 处理并平移到开头', () => {
    expect(localViewRange(100, 10, NaN)).toEqual({
      startSeconds: 0,
      endSeconds: 10
    });
    expect(localViewRange(100, 10, Infinity)).toEqual({
      startSeconds: 0,
      endSeconds: 10
    });
  });

  it('非法时长回退为空整轨', () => {
    expect(localViewRange(NaN, 10, 5)).toEqual({ startSeconds: 0, endSeconds: 0 });
  });
});

describe('局部视窗秒数输入解析', () => {
  it('正常数字（含小数与首尾空白）', () => {
    expect(parseWindowSeconds('10')).toBe(10);
    expect(parseWindowSeconds(' 2.5 ')).toBe(2.5);
    expect(parseWindowSeconds('0.5')).toBe(0.5);
  });

  it('空输入非法', () => {
    expect(parseWindowSeconds('')).toBeNull();
    expect(parseWindowSeconds('   ')).toBeNull();
  });

  it('非数字非法', () => {
    expect(parseWindowSeconds('abc')).toBeNull();
    expect(parseWindowSeconds('10秒')).toBeNull();
    expect(parseWindowSeconds('Infinity')).toBeNull();
  });

  it('不大于零非法', () => {
    expect(parseWindowSeconds('0')).toBeNull();
    expect(parseWindowSeconds('-3')).toBeNull();
    expect(parseWindowSeconds('-0.5')).toBeNull();
  });
});

describe('页面提示文案', () => {
  it('常量与页面显示一致', () => {
    expect(SHORT_RECORDING_NOTICE).toBe('录音短于局部视窗，已显示整轨');
    expect(INVALID_WINDOW_NOTICE).toBe('局部视窗秒数必须大于零');
  });
});
