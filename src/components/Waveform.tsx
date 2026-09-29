import { useEffect, useRef } from 'react';
import type { ClipSegment } from '../audio/types';
import type { DiffMembership, DiffSegment } from '../audio/compare';
import type { ReworkMembership, ReworkDiffSegment } from '../audio/rework-compare';
import type { ViewRange } from '../audio/view-range';

/** 差异条着色：与差异表共用同一差异数组的标记 */
export const DIFF_STRIPE_COLORS: Record<DiffMembership, string> = {
  BASELINE_ONLY: '#ff7a45',
  CANDIDATE_ONLY: '#52c41a',
  BOTH: '#94a3b8'
};

/**
 * 返工对照差异条着色：与返工差异表共用同一 ReworkDiffSegment 数组。
 * - 橙：仅原件（返工已修复）；绿：仅返工件（新引入）；灰：两边仍削波；
 * - 蓝/紫斜纹色：落在重叠区外、不可比较，绝不用橙/绿暗示质量变化。
 */
export const REWORK_STRIPE_COLORS: Record<ReworkMembership, string> = {
  BASELINE_ONLY: '#ff7a45',
  REWORK_ONLY: '#52c41a',
  BOTH: '#94a3b8',
  BASELINE_UNCOMPARED: '#4d7cff',
  REWORK_UNCOMPARED: '#b37dff'
};

/** 差异条片段：候选规则比较或返工对照二选一，二者不共用着色映射 */
export type StripeSegment =
  | ({ source: 'rule' } & DiffSegment)
  | ({ source: 'rework' } & ReworkDiffSegment);

interface WaveformProps {
  data: Float32Array;
  sampleRate: number;
  segments: ClipSegment[];
  positionSeconds: number;
  /** 页面统一的视图状态：整轨或局部起止秒数 */
  viewRange: ViewRange;
  onSeek: (seconds: number) => void;
  /** 候选规则比较的差异片段（与差异表同一数组）；未启用比较时不传 */
  diffs?: DiffSegment[];
  /**
   * 差异条片段（规则比较或返工对照，与各自差异表同一数组）。
   * 传入时优先于 diffs；diffs 仅为原单文件规则比较保留。
   */
  stripes?: StripeSegment[];
  /** 差异条按哪一侧坐标着色（返工对照双波形分别取各自时间轴） */
  stripeSide?: 'baseline' | 'rework';
}

/**
 * 声道波形（Canvas 2D）：
 * - 仅绘制 viewRange 指定的起止秒数（整轨或局部视窗）；
 * - 每个像素列取该采样区间的 min/max 包络，支持长录音整轨显示；
 * - 削波段以红色底纹 + 描边高亮（仅与视窗重叠部分）；
 * - 启用候选规则比较时，底部差异条按同一差异数组逐段着色；
 * - 点击波形按视窗横轴比例换算定位时刻。
 */
export default function Waveform({
  data,
  sampleRate,
  segments,
  positionSeconds,
  viewRange,
  onSeek,
  diffs,
  stripes,
  stripeSide
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const duration = data.length / sampleRate;

  // 视图状态收敛为起止秒数；异常输入（终点不大于起点）回退整轨
  const viewValid = viewRange.endSeconds > viewRange.startSeconds;
  const startSec = viewValid ? viewRange.startSeconds : 0;
  const span = viewValid ? viewRange.endSeconds - viewRange.startSeconds : duration;

  // 回调放在 ref 里，避免 Redraw 闭包过期
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const cssWidth = wrap.clientWidth;
      const cssHeight = wrap.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(cssWidth * dpr));
      canvas.height = Math.max(1, Math.round(cssHeight * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      const mid = cssHeight / 2;
      const endSec = startSec + span;

      // 中线与阈值参考线
      ctx.strokeStyle = 'rgba(147,163,187,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, mid + 0.5);
      ctx.lineTo(cssWidth, mid + 0.5);
      ctx.stroke();

      const xForTime = (t: number) =>
        span <= 0 ? 0 : ((t - startSec) / span) * cssWidth;

      // 与视窗重叠的削波段
      const visible = segments
        .map((seg) => ({
          start: Math.max(seg.startSeconds, startSec),
          end: Math.min(seg.endSeconds, endSec),
          seg
        }))
        .filter((s) => s.end > s.start);

      // 削波高亮：红色全高底纹 + 红色包络
      for (const s of visible) {
        const x0 = xForTime(s.start);
        const x1 = Math.max(x0 + 1, xForTime(s.end));
        ctx.fillStyle = 'rgba(255,77,79,0.22)';
        ctx.fillRect(x0, 0, x1 - x0, cssHeight);
      }

      // 波形包络：视窗起止秒数换算到采样帧区间
      ctx.strokeStyle = '#6ea8fe';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const n = data.length;
      const firstFrame = Math.max(
        0,
        Math.min(n, Math.floor(startSec * sampleRate))
      );
      const lastFrame = Math.max(
        firstFrame,
        Math.min(n, Math.ceil(endSec * sampleRate))
      );
      const frameSpan = Math.max(1, lastFrame - firstFrame);
      for (let x = 0; x < cssWidth; x++) {
        const start = firstFrame + Math.floor((x / cssWidth) * frameSpan);
        const end = Math.max(
          start + 1,
          firstFrame + Math.ceil(((x + 1) / cssWidth) * frameSpan)
        );
        let min = Infinity;
        let max = -Infinity;
        for (let i = start; i < end && i < n; i++) {
          const v = data[i]!;
          if (v < min) min = v;
          if (v > max) max = v;
        }
        if (min === Infinity) continue;
        const yMax = mid - max * (mid - 1);
        const yMin = mid - min * (mid - 1);
        ctx.moveTo(x + 0.5, yMax);
        ctx.lineTo(x + 0.5, yMin);
      }
      ctx.stroke();

      // 削波段描边边界（仅画落在视窗内的端点）
      ctx.strokeStyle = 'rgba(255,77,79,0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const { seg } of visible) {
        if (seg.startSeconds >= startSec) {
          const x0 = Math.round(xForTime(seg.startSeconds)) + 0.5;
          ctx.moveTo(x0, 0);
          ctx.lineTo(x0, cssHeight);
        }
        if (seg.endSeconds <= endSec) {
          const x1 = Math.round(xForTime(seg.endSeconds)) - 0.5;
          ctx.moveTo(x1, 0);
          ctx.lineTo(x1, cssHeight);
        }
      }
      ctx.stroke();

      // 差异条：规则比较或返工对照均按“同一差异数组”逐段着色（底部横带）
      const stripeList: StripeSegment[] =
        stripes ??
        (diffs
          ? diffs.map((d) => ({ ...d, source: 'rule' as const }))
          : []);
      if (stripeList.length > 0) {
        const stripHeight = 12;
        const stripTop = cssHeight - stripHeight;
        for (const d of stripeList) {
          // 返工对照的双波形各自只画本侧坐标（对侧为 null 的片段跳过）
          let sSec: number | null;
          let eSec: number | null;
          let color: string;
          if (d.source === 'rework') {
            const side = stripeSide ?? 'baseline';
            const s = side === 'rework' ? d.reworkStartSeconds : d.baselineStartSeconds;
            const e = side === 'rework' ? d.reworkEndSeconds : d.baselineEndSeconds;
            if (s === null || e === null) continue;
            sSec = s;
            eSec = e;
            color = REWORK_STRIPE_COLORS[d.membership];
          } else {
            sSec = d.startSeconds;
            eSec = d.endSeconds;
            color = DIFF_STRIPE_COLORS[d.membership];
          }
          const s = Math.max(sSec, startSec);
          const e = Math.min(eSec, endSec);
          if (e <= s) continue;
          const x0 = xForTime(s);
          const x1 = Math.max(x0 + 1, xForTime(e));
          ctx.fillStyle = color;
          ctx.fillRect(x0, stripTop, x1 - x0, stripHeight);
        }
      }

      // 播放位置游标（仅当位置落在视窗内）
      if (positionSeconds >= startSec && positionSeconds <= endSec) {
        const px = Math.min(cssWidth - 1, Math.max(0, xForTime(positionSeconds)));
        ctx.strokeStyle = '#ffd34d';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px + 0.5, 0);
        ctx.lineTo(px + 0.5, cssHeight);
        ctx.stroke();
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [data, sampleRate, segments, positionSeconds, startSec, span, duration, diffs, stripes, stripeSide]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || span <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    // 按视窗横轴比例换算到整轨时刻（必须加上视窗起点）
    onSeekRef.current(startSec + ratio * span);
  };

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        data-testid="waveform-canvas"
      />
    </div>
  );
}
