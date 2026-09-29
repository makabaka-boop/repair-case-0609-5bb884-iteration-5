/**
 * 时间换算工具。
 *
 * 规则：
 * - 起止时间分别为首帧和末帧后一帧除以采样率。
 * - 毫秒显示取最接近整数；恰为 0.5 时向上取整（半数向上，half-up）。
 *   所有帧索引非负，换算结果均为非负数。
 */

/** 半数向上取整：正数上 Math.round 等价；独立实现以明确“0.5 向上取整”语义 */
export function roundHalfUp(x: number): number {
  if (!Number.isFinite(x)) {
    throw new RangeError(`无法对非有限值取整: ${String(x)}`);
  }
  return Math.floor(x + 0.5);
}

/** 首帧时间（秒） */
export function frameToStartSeconds(frame: number, sampleRate: number): number {
  assertPositiveRate(sampleRate);
  return frame / sampleRate;
}

/** 末帧后一帧时间（秒） */
export function frameToEndSeconds(endFrame: number, sampleRate: number): number {
  assertPositiveRate(sampleRate);
  return (endFrame + 1) / sampleRate;
}

/** 秒 → 显示用毫秒（四舍五入，0.5 向上） */
export function secondsToMs(seconds: number): number {
  return roundHalfUp(seconds * 1000);
}

/** 帧 → 起始毫秒（显示） */
export function frameToStartMs(frame: number, sampleRate: number): number {
  return secondsToMs(frameToStartSeconds(frame, sampleRate));
}

/** 帧（末帧）→ 结束毫秒（显示），取末帧后一帧 */
export function frameToEndMs(endFrame: number, sampleRate: number): number {
  return secondsToMs(frameToEndSeconds(endFrame, sampleRate));
}

function assertPositiveRate(sampleRate: number): void {
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) {
    throw new RangeError(`非法采样率: ${String(sampleRate)}`);
  }
}
