import {
  DIFF_MEMBERSHIP_LABELS,
  type DiffSegment
} from '../audio/compare';

interface DiffListProps {
  segments: DiffSegment[];
  onLocate: (segment: DiffSegment) => void;
}

/** 单声道差异片段列表；行点击 / 按钮均可定位试听。 */
export default function DiffList({ segments, onLocate }: DiffListProps) {
  return (
    <div className="segment-table-wrap">
      <table className="segment-table diff-table">
        <thead>
          <tr>
            <th>#</th>
            <th>标记</th>
            <th>起始 (ms)</th>
            <th>结束 (ms)</th>
            <th>时长 (ms)</th>
            <th>帧范围</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {segments.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={7}>该声道两套规则均无削波区间</td>
            </tr>
          ) : (
            segments.map((seg, i) => (
              <tr
                key={`${seg.startFrame}-${seg.endFrame}-${seg.membership}`}
                data-testid="diff-row"
                data-membership={seg.membership}
                onClick={() => onLocate(seg)}
              >
                <td>{i + 1}</td>
                <td>
                  <span
                    className={`diff-badge diff-${seg.membership.toLowerCase().replace(/_/g, '-')}`}
                  >
                    {DIFF_MEMBERSHIP_LABELS[seg.membership]}
                  </span>
                </td>
                <td>{seg.startMs}</td>
                <td>{seg.endMs}</td>
                <td>{seg.durationMs}</td>
                <td>
                  {seg.startFrame}–{seg.endFrame}
                </td>
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
