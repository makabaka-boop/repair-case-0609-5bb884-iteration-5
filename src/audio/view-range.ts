/**
 * 波形视窗范围（纯函数）。
 *
 * 整轨与局部视窗统一表示为 [startSeconds, endSeconds] 一组视图状态：
 * - 局部视窗以关注时刻为中心、保持指定宽度，触及录音首尾时仅平移范围；
 * - 录音时长小于等于视窗秒数时回退为整轨（由页面提示“录音短于局部视窗”）。
 * 纯计算、不触碰 DOM 与网络，扫描结果与本地处理契约不受影响。
 */

export interface ViewRange {
  /** 视窗起点（秒，含） */
  startSeconds: number;
  /** 视窗终点（秒，含） */
  endSeconds: number;
}

/** 录音短于局部视窗、已回退整轨时的页面提示 */
export const SHORT_RECORDING_NOTICE = '录音短于局部视窗，已显示整轨';
/** 局部视窗秒数输入非法时的就地提示 */
export const INVALID_WINDOW_NOTICE = '局部视窗秒数必须大于零';

/** 整轨视图范围：[0, 时长]；非法时长按 0 处理 */
export function fullTrackRange(durationSeconds: number): ViewRange {
  const safe =
    Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : 0;
  return { startSeconds: 0, endSeconds: safe };
}

/**
 * 局部视窗范围：
 * - windowSeconds 非法或 >= 录音时长 → 回退整轨；
 * - 否则以 focusSeconds 为中心保持 windowSeconds 宽度，
 *   触及首尾时仅平移（起点收敛到 [0, 时长 - 宽度]）。
 */
export function localViewRange(
  durationSeconds: number,
  windowSeconds: number,
  focusSeconds: number
): ViewRange {
  const full = fullTrackRange(durationSeconds);
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return full;
  if (windowSeconds >= full.endSeconds) return full;

  const focus = Number.isFinite(focusSeconds) ? focusSeconds : 0;
  // 先将起点钳制到 [0, 时长 - 宽度]，终点由起点加固定宽度得到：
  // 触及首尾只平移范围，宽度始终保持 windowSeconds。
  const maxStart = full.endSeconds - windowSeconds;
  const start = Math.min(maxStart, Math.max(0, focus - windowSeconds / 2));
  return {
    startSeconds: start,
    endSeconds: start + windowSeconds
  };
}

/**
 * 解析局部视窗秒数输入。
 * 空、非数字或不大于零 → null（调用方保持当前视图不变并就地提示）。
 */
export function parseWindowSeconds(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}
