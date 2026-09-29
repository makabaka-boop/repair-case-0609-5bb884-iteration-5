import type { ClipSegment } from '../audio/types';

interface SegmentListProps {
  segments: ClipSegment[];
  onLocate: (segment: ClipSegment) => void;
}

/** 单声道削波区间列表；行点击 / 按钮均可定位试听。 */
export default function SegmentList({ segments, onLocate }: SegmentListProps) {
  return (
    <div className="segment-table-wrap">
      <table className="segment-table">
        <thead>
          <tr>
            <th>#</th>
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
              <td colSpan={6}>该声道未检出削波段</td>
            </tr>
          ) : (
            segments.map((seg, i) => (
              <tr
                key={`${seg.startFrame}-${seg.endFrame}`}
                data-testid="segment-row"
                onClick={() => onLocate(seg)}
              >
                <td>{i + 1}</td>
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
