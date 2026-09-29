import { REWORK_DIFF_KIND_LABELS, type ReworkDiffSegment } from '../audio/rework';

interface ReworkDiffListProps {
  segments: ReworkDiffSegment[];
  /** 行定位：回调收到该片段在两侧各自的时间（秒），未覆盖一侧为 null */
  onLocate: (segment: ReworkDiffSegment) => void;
}

const KIND_CLASS: Record<ReworkDiffSegment['kind'], string> = {
  FIXED: 'rework-fixed',
  NEW: 'rework-new',
  BOTH: 'rework-both',
  BASELINE_ONLY: 'rework-incomparable',
  REWORK_ONLY: 'rework-incomparable'
};

function msCell(value: number | null): string {
  return value === null ? '—' : `${value}`;
}

function frameCell(value: number | null): string {
  return value === null ? '—' : `${value}`;
}

/**
 * 单声道返工对照差异表：差异片段、双波形着色共用同一数组。
 * 行点击 / 按钮定位试听时，两侧时间分别映射回各自文件坐标
 * （未覆盖的不可比较区域显示“—”，不触发该侧跳转）。
 */
export default function ReworkDiffList({ segments, onLocate }: ReworkDiffListProps) {
  return (
    <div className="segment-table-wrap">
      <table className="segment-table rework-diff-table">
        <thead>
          <tr>
            <th>#</th>
            <th>标记</th>
            <th>基线起始 (ms)</th>
            <th>基线结束 (ms)</th>
            <th>返工起始 (ms)</th>
            <th>返工结束 (ms)</th>
            <th>基线帧</th>
            <th>返工帧</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {segments.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={9}>真实重叠区内两份文件均无削波区间</td>
            </tr>
          ) : (
            segments.map((seg, i) => (
              <tr
                key={`${seg.startFrame}-${seg.endFrame}-${seg.kind}`}
                data-testid="rework-diff-row"
                data-kind={seg.kind}
                onClick={() => onLocate(seg)}
              >
                <td>{i + 1}</td>
                <td>
                  <span className={`diff-badge ${KIND_CLASS[seg.kind]}`}>
                    {REWORK_DIFF_KIND_LABELS[seg.kind]}
                  </span>
                </td>
                <td>{msCell(seg.baselineStartMs)}</td>
                <td>{msCell(seg.baselineEndMs)}</td>
                <td>{msCell(seg.reworkStartMs)}</td>
                <td>{msCell(seg.reworkEndMs)}</td>
                <td>{frameCell(seg.baselineStartFrame)}</td>
                <td>{frameCell(seg.reworkStartFrame)}</td>
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
