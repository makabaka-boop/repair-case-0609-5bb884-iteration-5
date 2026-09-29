import {
  REWORK_MEMBERSHIP_LABELS,
  type ReworkDiffSegment
} from '../audio/rework-compare';

interface ReworkDiffListProps {
  segments: ReworkDiffSegment[];
  onLocate: (segment: ReworkDiffSegment) => void;
}

function frameText(range: { startFrame: number; endFrame: number } | null): string {
  return range ? `${range.startFrame}–${range.endFrame}` : '—';
}

function msText(start: number | null, end: number | null): string {
  return start === null || end === null ? '—' : `${start}–${end}`;
}

/**
 * 返工对照差异表：与双波形着色共用同一 ReworkDiffSegment 数组。
 * 行内同时给出原件与返工件坐标，点击行 / 按钮定位试听时由页面
 * 分别映射回各自文件时间轴（两套坐标都在该片段上）。
 */
export default function ReworkDiffList({
  segments,
  onLocate
}: ReworkDiffListProps) {
  return (
    <div className="segment-table-wrap">
      <table className="segment-table diff-table rework-diff-table">
        <thead>
          <tr>
            <th>#</th>
            <th>裁决</th>
            <th>原件 (ms)</th>
            <th>原件帧</th>
            <th>返工件 (ms)</th>
            <th>返工帧</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {segments.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={7}>重叠区内两份扫描均无削波区间</td>
            </tr>
          ) : (
            segments.map((seg, i) => (
              <tr
                key={`${seg.membership}-${i}`}
                data-testid="rework-diff-row"
                data-membership={seg.membership}
                onClick={() => onLocate(seg)}
              >
                <td>{i + 1}</td>
                <td>
                  <span
                    className={`diff-badge rework-${seg.membership
                      .toLowerCase()
                      .replace(/_/g, '-')}`}
                  >
                    {REWORK_MEMBERSHIP_LABELS[seg.membership]}
                  </span>
                </td>
                <td>{msText(seg.baselineStartMs, seg.baselineEndMs)}</td>
                <td>{frameText(seg.baselineFrame)}</td>
                <td>{msText(seg.reworkStartMs, seg.reworkEndMs)}</td>
                <td>{frameText(seg.reworkFrame)}</td>
                <td>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onLocate(seg);
                    }}
                  >
                    定位试听
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
