import { describe, expect, it } from 'vitest';
import {
  frameToEndMs,
  frameToEndSeconds,
  frameToStartMs,
  frameToStartSeconds,
  roundHalfUp,
  secondsToMs
} from '../../src/audio/time';

describe('半数向上取整（恰为 0.5 向上）', () => {
  it('整数不变', () => {
    expect(roundHalfUp(0)).toBe(0);
    expect(roundHalfUp(1)).toBe(1);
    expect(roundHalfUp(100)).toBe(100);
  });

  it('恰为 .5 一律向上取整', () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(1.5)).toBe(2);
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(123.5)).toBe(124);
  });

  it('小于半向下、大于半向上', () => {
    expect(roundHalfUp(0.499)).toBe(0);
    expect(roundHalfUp(0.501)).toBe(1);
    expect(roundHalfUp(2.4999)).toBe(2);
  });

  it('非有限值抛错', () => {
    expect(() => roundHalfUp(NaN)).toThrow(RangeError);
    expect(() => roundHalfUp(Infinity)).toThrow(RangeError);
  });
});

describe('帧 → 秒 / 毫秒换算边界', () => {
  const SR = 1000;

  it('起始时间 = 首帧 / 采样率', () => {
    expect(frameToStartSeconds(0, SR)).toBe(0);
    expect(frameToStartSeconds(5, SR)).toBe(0.005);
    expect(frameToStartMs(0, SR)).toBe(0);
    expect(frameToStartMs(5, SR)).toBe(5);
  });

  it('结束时间 = （末帧 + 1）/ 采样率', () => {
    // 段 [2..4]，末帧后一帧为 5
    expect(frameToEndSeconds(4, SR)).toBe(0.005);
    expect(frameToEndMs(4, SR)).toBe(5);
    // 首帧 0、末帧 0 的单帧段，结束为 1 帧时间
    expect(frameToEndSeconds(0, SR)).toBe(0.001);
    expect(frameToEndMs(0, SR)).toBe(1);
  });

  it('毫秒四舍五入边界：2.4999 帧 @1000Hz', () => {
    // 秒 *1000 后恰为整数附近的常规取整
    expect(secondsToMs(0.0024999)).toBe(2);
    expect(secondsToMs(0.0025)).toBe(3); // 恰 0.5 向上
    expect(secondsToMs(0.0025001)).toBe(3);
  });

  it('非整除采样率换算：8000Hz 下 1 帧 = 0.125ms', () => {
    expect(frameToStartMs(0, 8000)).toBe(0);
    expect(frameToStartMs(4, 8000)).toBe(1); // 0.5ms 恰向上
    expect(frameToStartMs(8, 8000)).toBe(1); // 1ms
    expect(frameToStartMs(12, 8000)).toBe(2); // 1.5ms 恰向上
  });

  it('段时长边界：44100Hz 下 22 帧 ≈ 0.4989ms 显示 0ms，23 帧 ≈ 0.5215ms 显示 1ms', () => {
    expect(secondsToMs(22 / 44100)).toBe(0);
    expect(secondsToMs(23 / 44100)).toBe(1);
  });

  it('非法采样率抛错', () => {
    expect(() => frameToStartSeconds(0, 0)).toThrow(RangeError);
    expect(() => frameToEndSeconds(0, -1)).toThrow(RangeError);
    expect(() => frameToStartSeconds(0, NaN)).toThrow(RangeError);
  });
});
