import { useEffect, useReducer, useRef, useState } from 'react';
import { loadAndScanWav, type LoadedWav } from './audio/decoder';
import { ERROR_MESSAGES, WavError } from './audio/types';
import {
  INVALID_RULE_NOTICE,
  buildComparison,
  parseCandidateRule,
  type RuleComparison
} from './audio/compare';
import {
  INVALID_ANCHOR_NOTICE,
  MIN_ANCHOR_FRAMES,
  baselineWaveMarks,
  buildReworkComparison,
  findBestAlignment,
  mapViewRangeToRework,
  parseAnchorSelection,
  reworkWaveMarks,
  reworkSecondsToBaseline,
  type AlignmentResult,
  type AnchorInput,
  type ReworkComparison,
  type ReworkDiffSegment
} from './audio/rework';
import {
  initialReworkSession,
  isStaleResult,
  reworkSessionReducer,
  type ReworkLoadError
} from './audio/rework-session';
import {
  INVALID_WINDOW_NOTICE,
  SHORT_RECORDING_NOTICE,
  fullTrackRange,
  localViewRange,
  parseWindowSeconds,
  type ViewRange
} from './audio/view-range';
import Waveform, { DIFF_STRIPE_COLORS, REWORK_MARK_COLORS } from './components/Waveform';
import SegmentList from './components/SegmentList';
import DiffList from './components/DiffList';
import ReworkDiffList from './components/ReworkDiffList';

type Status = 'idle' | 'loading' | 'error' | 'done';

interface ErrorState {
  code: string;
  title: string;
  detail: string;
}

const CHANNEL_LABELS = ['左声道', '右声道', '中置声道'];

function channelLabel(index: number, total: number): string {
  if (total === 1) return '单声道';
  if (total === 2) return CHANNEL_LABELS[index] ?? `声道 ${index + 1}`;
  return CHANNEL_LABELS[index] ?? `声道 ${index + 1}`;
}

function formatSeconds(totalSeconds: number): string {
  return totalSeconds.toFixed(3);
}

const DEFAULT_WINDOW_INPUT = '10';

/** 候选规则输入默认值：与基线一致（0.999 / 3 帧 / 2 帧） */
const DEFAULT_RULE_INPUTS = {
  threshold: '0.999',
  minRunFrames: '3',
  maxMergeGap: '2'
};

/** 返工锚点输入默认值：起点 0 s、时长 0.1 s、声道 0、搜索 ±200 帧 */
const DEFAULT_ANCHOR_INPUTS: AnchorInput = {
  anchorStart: '0',
  anchorDuration: '0.1',
  channel: '0',
  maxOffsetFrames: '200'
};

export default function App() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<ErrorState | null>(null);
  const [loaded, setLoaded] = useState<LoadedWav | null>(null);
  const [position, setPosition] = useState(0);
  // 页面唯一视图状态：整轨或局部视窗的起止秒数（由纯函数算出）
  const [viewRange, setViewRange] = useState<ViewRange | null>(null);
  const [windowInput, setWindowInput] = useState(DEFAULT_WINDOW_INPUT);
  const [windowSeconds, setWindowSeconds] = useState(
    Number(DEFAULT_WINDOW_INPUT)
  );
  const [windowError, setWindowError] = useState<string | null>(null);
  const [viewNotice, setViewNotice] = useState<string | null>(null);
  // 候选规则比较：扫描结果、差异表与 Canvas 共用同一 comparison 对象，
  // 单次 setState 原子生效，不会出现列表已更新而波形仍用旧结果的中间态
  const [ruleInputs, setRuleInputs] = useState(DEFAULT_RULE_INPUTS);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<RuleComparison | null>(null);
  // 返工文件对照：状态机统一裁决（失败保留旧对照、新基线清空、迟到结果不覆盖）
  const [rework, dispatchRework] = useReducer(
    reworkSessionReducer,
    initialReworkSession
  );
  const [anchorInputs, setAnchorInputs] = useState<AnchorInput>(
    DEFAULT_ANCHOR_INPUTS
  );
  const [anchorError, setAnchorError] = useState<string | null>(null);
  const [reworkPosition, setReworkPosition] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const reworkAudioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const reworkObjectUrlRef = useRef<string | null>(null);
  // 文件选择单调序号：基线/返工共用，迟到的解码或对齐结果必须小于当前值即丢弃
  const loadGenRef = useRef(0);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      if (reworkObjectUrlRef.current) {
        URL.revokeObjectURL(reworkObjectUrlRef.current);
      }
    };
  }, []);

  const handleFile = async (file: File | null | undefined) => {
    if (!file) return;
    const gen = ++loadGenRef.current;
    setStatus('loading');
    setError(null);
    try {
      const next = await loadAndScanWav(file);
      // 迟到的基线解码结果不得覆盖更新的文件选择
      if (isStaleResult(loadGenRef.current, gen)) {
        URL.revokeObjectURL(next.objectUrl);
        return;
      }
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = next.objectUrl;
      setLoaded(next);
      setPosition(0);
      // 新文件复位视图：整轨显示，视窗秒数回到默认十秒
      setViewRange(fullTrackRange(next.result.durationSeconds));
      setWindowInput(DEFAULT_WINDOW_INPUT);
      setWindowSeconds(Number(DEFAULT_WINDOW_INPUT));
      setWindowError(null);
      setViewNotice(null);
      // 新文件载入：旧比较基于旧 PCM，必须清空
      setComparison(null);
      setRuleInputs(DEFAULT_RULE_INPUTS);
      setRuleError(null);
      // 新基线载入：返工对照（含已确认旧对照）全部清空
      if (reworkObjectUrlRef.current) {
        URL.revokeObjectURL(reworkObjectUrlRef.current);
        reworkObjectUrlRef.current = null;
      }
      setAnchorInputs(DEFAULT_ANCHOR_INPUTS);
      setAnchorError(null);
      setReworkPosition(0);
      // 基线与返工共用同一单调序号；gen 即本次基线选择的序号，
      // 加载期间若又选了更新的文件，上面的 isStaleResult 早退不会走到这里。
      dispatchRework({ type: 'baseline-changed', gen });
      setStatus('done');
    } catch (err) {
      if (isStaleResult(loadGenRef.current, gen)) return;
      if (err instanceof WavError) {
        setError({
          code: err.code,
          title: ERROR_MESSAGES[err.code],
          detail: err.message
        });
      } else {
        const detail = err instanceof Error ? err.message : String(err);
        setError({
          code: 'SCAN_FAILED',
          title: ERROR_MESSAGES.DECODE_FAILED,
          detail: `扫描过程中发生错误：${detail}`
        });
      }
      setLoaded(null);
      // 解码失败：清空旧比较，避免残留基于其他文件的结论
      setComparison(null);
      setRuleError(null);
      setStatus('error');
    }
  };

  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !loaded) return;
    const clamped = Math.min(
      loaded.result.durationSeconds,
      Math.max(0, seconds)
    );
    audio.currentTime = clamped;
    setPosition(clamped);
    void audio.play().catch(() => {
      /* 浏览器拦截自动播放时保持定位即可 */
    });
  };

  /**
   * 以 focusSeconds 为中心切换到局部视窗；
   * 录音不宽于视窗秒数时回退整轨并提示。
   */
  const focusLocalView = (focusSeconds: number, widthSeconds: number) => {
    if (!loaded) return;
    const duration = loaded.result.durationSeconds;
    if (duration <= widthSeconds) {
      setViewRange(fullTrackRange(duration));
      setViewNotice(SHORT_RECORDING_NOTICE);
    } else {
      setViewRange(localViewRange(duration, widthSeconds, focusSeconds));
      setViewNotice(null);
    }
  };

  const locateSegment = (seg: { startSeconds: number }) => {
    // 播放器仍跳到段起点，同时各声道同步显示该时刻附近的局部波形
    seekTo(seg.startSeconds);
    focusLocalView(seg.startSeconds, windowSeconds);
  };

  const locateFirst = () => {
    if (loaded?.result.firstClip) {
      locateSegment(loaded.result.firstClip.segment);
    }
  };

  /**
   * 应用候选规则：非法输入就地提示并保留上一次有效比较；
   * 合法输入一次性算出完整比较结果（扫描 + 差异），单次 setState 生效。
   */
  const applyRule = () => {
    if (!loaded) return;
    const rule = parseCandidateRule(ruleInputs);
    if (rule === null) {
      setRuleError(INVALID_RULE_NOTICE);
      return;
    }
    setRuleError(null);
    setComparison(buildComparison(loaded.result, rule));
  };

  const clearComparison = () => {
    setComparison(null);
    setRuleError(null);
  };

  // -------------------------------------------------------------------------
  // 返工文件对照
  // -------------------------------------------------------------------------

  const mapWavErrorToRework = (err: unknown): ReworkLoadError => {
    if (err instanceof WavError) {
      return {
        code: err.code,
        title: ERROR_MESSAGES[err.code],
        detail: err.message
      };
    }
    const detail = err instanceof Error ? err.message : String(err);
    return {
      code: 'SCAN_FAILED',
      title: ERROR_MESSAGES.DECODE_FAILED,
      detail: `返工文件扫描过程中发生错误：${detail}`
    };
  };

  /** 选择返工文件：解码失败保留旧对照，迟到解码结果不得覆盖较新文件 */
  const handleReworkFile = async (file: File | null | undefined) => {
    if (!file || !loaded) return;
    const gen = ++loadGenRef.current;
    dispatchRework({ type: 'rework-selected', gen });
    try {
      const next = await loadAndScanWav(file);
      if (isStaleResult(loadGenRef.current, gen)) {
        URL.revokeObjectURL(next.objectUrl);
        return;
      }
      if (reworkObjectUrlRef.current) {
        URL.revokeObjectURL(reworkObjectUrlRef.current);
      }
      reworkObjectUrlRef.current = next.objectUrl;
      setReworkPosition(0);
      setAnchorInputs((cur) => ({ ...cur, channel: '0' }));
      setAnchorError(null);
      dispatchRework({ type: 'rework-loaded', gen, loaded: next });
    } catch (err) {
      if (isStaleResult(loadGenRef.current, gen)) return;
      // 解码失败：reducer 保留已确认的旧返工与旧对照，仅就地报错
      dispatchRework({
        type: 'rework-failed',
        gen,
        error: mapWavErrorToRework(err)
      });
    }
  };

  const seekReworkAudio = (seconds: number) => {
    const audio = reworkAudioRef.current;
    if (!audio || !rework.loaded) return;
    const clamped = Math.min(
      rework.loaded.result.durationSeconds,
      Math.max(0, seconds)
    );
    audio.currentTime = clamped;
    setReworkPosition(clamped);
    void audio.play().catch(() => {
      /* 自动播放被拦截时保持定位即可 */
    });
  };

  /**
   * 对齐裁决：输入非法就地提示并保留旧对照；
   * 迟到的对齐结果（期间又换了文件）不能覆盖较新的文件。
   */
  const applyAlignment = () => {
    if (!loaded || !rework.loaded) return;
    // 捕获本次对齐时刻的文件序号：即便日后改为异步计算，reducer 也会用它
    // 丢弃迟到结果，绝不允许旧对齐覆盖更新的文件。
    const gen = loadGenRef.current;
    const selection = parseAnchorSelection(anchorInputs);
    if (selection === null) {
      setAnchorError(INVALID_ANCHOR_NOTICE);
      return;
    }
    setAnchorError(null);
    let result: AlignmentResult = findBestAlignment({
      baseline: loaded.result,
      rework: rework.loaded.result,
      selection
    });
    let comparisonObject: ReworkComparison | null = null;
    if (result.status === 'aligned') {
      try {
        comparisonObject = buildReworkComparison(
          loaded.result,
          rework.loaded.result,
          result
        );
      } catch {
        // 理论上不会发生（对齐成功即同采样率/声道且有重叠），保险按无重叠失败处理
        result = {
          status: 'failed',
          reason: 'no-overlap',
          message: '对齐偏移下两份文件没有真实重叠帧，无法比较'
        };
        comparisonObject = null;
      }
    }
    dispatchRework({
      type: 'alignment-settled',
      gen,
      result,
      comparison: comparisonObject
    });
  };

  /**
   * 返工差异行定位试听：两个播放器共用同一偏移，
   * 分别映射回各自文件坐标跳转；未覆盖（不可比较）一侧不跳转。
   * 局部视窗以片段的全局（基线）坐标时刻为中心，双波形按偏移并排。
   */
  const locateReworkSegment = (seg: ReworkDiffSegment) => {
    if (!loaded) return;
    const sr = loaded.result.sampleRate;
    if (seg.baselineSecondsStart !== null) {
      seekTo(seg.baselineSecondsStart);
      focusLocalView(seg.baselineSecondsStart, windowSeconds);
    }
    if (seg.reworkSecondsStart !== null) {
      seekReworkAudio(seg.reworkSecondsStart);
      if (seg.baselineSecondsStart === null) {
        // 返工独有区域：基线侧不可比较，视窗中心由返工时间换算回全局坐标
        const offsetFrames = rework.comparison?.alignment.offsetFrames ?? 0;
        focusLocalView(
          reworkSecondsToBaseline(seg.reworkSecondsStart, offsetFrames, sr),
          windowSeconds
        );
      }
    }
  };

  const applyWindow = () => {
    if (!loaded) return;
    const parsed = parseWindowSeconds(windowInput);
    if (parsed === null) {
      // 非法输入：不改变当前视图，就地提示
      setWindowError(INVALID_WINDOW_NOTICE);
      return;
    }
    setWindowError(null);
    setWindowSeconds(parsed);
    // 立即以刚解析出的秒数重算视窗；windowSeconds 状态尚未提交，
    // 不能直接使用（否则首次应用仍按旧宽度，显示与输入不同步）
    focusLocalView(position, parsed);
  };

  const backToFull = () => {
    if (!loaded) return;
    setViewRange(fullTrackRange(loaded.result.durationSeconds));
    setViewNotice(null);
  };

  const isFullTrack =
    loaded !== null &&
    viewRange !== null &&
    viewRange.startSeconds <= 0 &&
    viewRange.endSeconds >= loaded.result.durationSeconds;

  const reworkComparison = rework.comparison;
  const reworkViewRange: ViewRange | null =
    loaded !== null && viewRange !== null && reworkComparison !== null
      ? mapViewRangeToRework(
          viewRange,
          reworkComparison.alignment.offsetFrames,
          loaded.result.sampleRate
        )
      : null;

  return (
    <div className="app">
      <header className="app-header">
        <h1>口述史磁带 WAV 削波核验台</h1>
        <p>
          扫描归一化 PCM：|样本| ≥ 0.999 且连续 ≥ 3 帧成段；相邻段间隔 ≤ 2 帧合并。
          文件仅在本机浏览器内读取与解码，不上传、不访问任何在线服务。
        </p>
      </header>

      <section className="panel dropzone">
        <label htmlFor="file-input">
          <strong>选择本地单个 WAV 文件：</strong>
        </label>
        <input
          id="file-input"
          data-testid="file-input"
          type="file"
          accept=".wav,audio/wav,audio/x-wav,audio/wave"
          onChange={(e) => void handleFile(e.target.files?.[0])}
        />
        <span className="privacy-note">
          全程离线处理：文件不会离开当前设备，刷新页面即释放。
        </span>
        {status === 'loading' && (
          <span className="loading" data-testid="loading">
            正在本地解码与扫描…
          </span>
        )}
      </section>

      {status === 'error' && error && (
        <section className="panel error-box" data-testid="error-panel">
          <div className="error-title" data-testid="error-title">
            [{error.code}] {error.title}
          </div>
          <div className="error-detail" data-testid="error-detail">
            {error.detail}
          </div>
          <div className="error-detail" style={{ marginTop: 8, color: 'var(--muted)' }}>
            未生成任何扫描结果，请更换文件后重试。
          </div>
        </section>
      )}

      {status === 'done' && loaded && viewRange && (
        <>
          <section className="panel" data-testid="summary-panel">
            <div>
              <span
                className={`verdict ${loaded.result.hasClip ? 'fail' : 'pass'}`}
                data-testid="verdict"
              >
                {loaded.result.hasClip ? '需重采' : '可交付'}
              </span>
            </div>
            <div className="summary-grid">
              <div className="metric">
                <span className="metric-label">文件</span>
                <span className="metric-value">{loaded.result.fileName}</span>
              </div>
              <div className="metric">
                <span className="metric-label">采样率</span>
                <span className="metric-value">{loaded.result.sampleRate} Hz</span>
              </div>
              <div className="metric">
                <span className="metric-label">声道数</span>
                <span className="metric-value">{loaded.result.channels.length}</span>
              </div>
              <div className="metric">
                <span className="metric-label">总时长</span>
                <span className="metric-value">
                  {formatSeconds(loaded.result.durationSeconds)} s
                </span>
              </div>
              <div className="metric">
                <span className="metric-label">总削波时长（各声道累加）</span>
                <span className="metric-value" data-testid="total-clip-ms">
                  {loaded.result.totalClipMs} ms
                </span>
              </div>
              <div className="metric">
                <span className="metric-label">削波段数（各声道合计）</span>
                <span className="metric-value">
                  {loaded.result.channels.reduce(
                    (n: number, ch) => n + ch.segments.length,
                    0
                  )}
                </span>
              </div>
            </div>
            <div className="toolbar">
              {loaded.result.hasClip && (
                <button
                  className="primary"
                  onClick={locateFirst}
                  data-testid="locate-first"
                >
                  定位首个异常（
                  {channelLabel(
                    loaded.result.firstClip!.channel,
                    loaded.result.channels.length
                  )}
                  {' '}
                  {loaded.result.firstClip!.segment.startMs} ms）
                </button>
              )}
              <span className="privacy-note">
                点击波形或区间行即可定位并试听。
              </span>
            </div>
            <audio
              ref={audioRef}
              controls
              src={loaded.objectUrl}
              data-testid="audio-player"
              onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
            />
          </section>

          <section className="panel view-controls" data-testid="view-controls">
            <div className="view-controls-row">
              <label htmlFor="window-input">局部视窗（秒）：</label>
              <input
                id="window-input"
                data-testid="window-input"
                type="text"
                inputMode="decimal"
                value={windowInput}
                onChange={(e) => {
                  setWindowInput(e.target.value);
                  setWindowError(null);
                }}
              />
              <button onClick={applyWindow} data-testid="apply-window">
                应用
              </button>
              <button
                onClick={backToFull}
                data-testid="back-to-full"
                disabled={isFullTrack}
              >
                返回整轨
              </button>
              <span className="view-range" data-testid="view-range">
                当前视窗：{formatSeconds(viewRange.startSeconds)} –{' '}
                {formatSeconds(viewRange.endSeconds)} s（宽度{' '}
                {formatSeconds(viewRange.endSeconds - viewRange.startSeconds)}{' '}
                s）
              </span>
            </div>
            {windowError && (
              <div className="view-error" data-testid="window-error">
                {windowError}
              </div>
            )}
            {viewNotice && (
              <div className="view-notice" data-testid="view-notice">
                {viewNotice}
              </div>
            )}
          </section>

          <section className="panel compare-panel" data-testid="compare-panel">
            <h2 className="compare-title">候选规则比较（不影响上方基线结论）</h2>
            <div className="compare-controls">
              <label htmlFor="rule-threshold">阈值：</label>
              <input
                id="rule-threshold"
                data-testid="rule-threshold"
                type="text"
                inputMode="decimal"
                value={ruleInputs.threshold}
                onChange={(e) => {
                  setRuleInputs({ ...ruleInputs, threshold: e.target.value });
                  setRuleError(null);
                }}
              />
              <label htmlFor="rule-min-run">最短连续帧：</label>
              <input
                id="rule-min-run"
                data-testid="rule-min-run"
                type="text"
                inputMode="numeric"
                value={ruleInputs.minRunFrames}
                onChange={(e) => {
                  setRuleInputs({ ...ruleInputs, minRunFrames: e.target.value });
                  setRuleError(null);
                }}
              />
              <label htmlFor="rule-max-gap">合并间隔（帧）：</label>
              <input
                id="rule-max-gap"
                data-testid="rule-max-gap"
                type="text"
                inputMode="numeric"
                value={ruleInputs.maxMergeGap}
                onChange={(e) => {
                  setRuleInputs({ ...ruleInputs, maxMergeGap: e.target.value });
                  setRuleError(null);
                }}
              />
              <button onClick={applyRule} data-testid="apply-rule">
                应用候选规则
              </button>
              {comparison && (
                <button onClick={clearComparison} data-testid="clear-comparison">
                  关闭比较
                </button>
              )}
            </div>
            {ruleError && (
              <div className="view-error" data-testid="rule-error">
                {ruleError}
              </div>
            )}
            {comparison && (
              <div className="compare-summary" data-testid="compare-summary">
                <div className="compare-verdicts">
                  <span className="compare-verdict-item">
                    基线（0.999 / 3 帧 / 2 帧）：
                    <span
                      className={`verdict ${loaded.result.hasClip ? 'fail' : 'pass'}`}
                      data-testid="baseline-verdict"
                    >
                      {loaded.result.hasClip ? '需重采' : '可交付'}
                    </span>
                    <span className="compare-count" data-testid="baseline-count">
                      {loaded.result.channels.reduce(
                        (n, ch) => n + ch.segments.length,
                        0
                      )}{' '}
                      段
                    </span>
                  </span>
                  <span className="compare-verdict-item">
                    候选（{comparison.rule.threshold} /{' '}
                    {comparison.rule.minRunFrames} 帧 /{' '}
                    {comparison.rule.maxMergeGap} 帧）：
                    <span
                      className={`verdict ${comparison.candidate.hasClip ? 'fail' : 'pass'}`}
                      data-testid="candidate-verdict"
                    >
                      {comparison.candidate.hasClip ? '需重采' : '可交付'}
                    </span>
                    <span className="compare-count" data-testid="candidate-count">
                      {comparison.candidate.channels.reduce(
                        (n, ch) => n + ch.segments.length,
                        0
                      )}{' '}
                      段
                    </span>
                  </span>
                </div>
                <div className="diff-summary" data-testid="diff-summary">
                  差异片段：新增 {comparison.candidateOnlyCount} · 漏掉{' '}
                  {comparison.baselineOnlyCount} · 共有 {comparison.bothCount}
                </div>
                {!comparison.hasDifference && (
                  <div className="view-notice" data-testid="no-diff">
                    候选规则与基线扫描结果一致，无新增或漏掉的削波区间
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="panel rework-panel" data-testid="rework-panel">
            <h2 className="compare-title">返工文件对照（区分真实修复与录制起点错位）</h2>
            <div className="compare-controls">
              <label htmlFor="rework-input">
                <strong>选择同一段录音的返工 WAV：</strong>
              </label>
              <input
                id="rework-input"
                data-testid="rework-input"
                type="file"
                accept=".wav,audio/wav,audio/x-wav,audio/wave"
                onChange={(e) => {
                  void handleReworkFile(e.target.files?.[0]);
                  // 允许再次选择同名文件（change 在相同路径下不会重复触发）
                  e.target.value = '';
                }}
              />
              {rework.status === 'loading' && (
                <span className="loading" data-testid="rework-loading">
                  返工文件解码中…
                </span>
              )}
            </div>

            {rework.loadError && (
              <div className="view-error" data-testid="rework-error">
                [{rework.loadError.code}] {rework.loadError.title}：
                {rework.loadError.detail}
              </div>
            )}

            {rework.loaded && (
              <>
                <div className="rework-meta" data-testid="rework-meta">
                  返工文件：{rework.loaded.result.fileName} ·{' '}
                  {rework.loaded.result.sampleRate} Hz ·{' '}
                  {rework.loaded.result.channels.length} 声道 ·{' '}
                  {formatSeconds(rework.loaded.result.durationSeconds)} s
                </div>

                <div className="compare-controls rework-anchor-controls">
                  <label htmlFor="anchor-start">锚点起点（秒）：</label>
                  <input
                    id="anchor-start"
                    data-testid="anchor-start"
                    type="text"
                    inputMode="decimal"
                    value={anchorInputs.anchorStart}
                    onChange={(e) => {
                      setAnchorInputs({ ...anchorInputs, anchorStart: e.target.value });
                      setAnchorError(null);
                    }}
                  />
                  <label htmlFor="anchor-duration">锚点时长（秒）：</label>
                  <input
                    id="anchor-duration"
                    data-testid="anchor-duration"
                    type="text"
                    inputMode="decimal"
                    value={anchorInputs.anchorDuration}
                    onChange={(e) => {
                      setAnchorInputs({
                        ...anchorInputs,
                        anchorDuration: e.target.value
                      });
                      setAnchorError(null);
                    }}
                  />
                  <label htmlFor="anchor-channel">锚点声道：</label>
                  <input
                    id="anchor-channel"
                    data-testid="anchor-channel"
                    type="text"
                    inputMode="numeric"
                    value={anchorInputs.channel}
                    onChange={(e) => {
                      setAnchorInputs({ ...anchorInputs, channel: e.target.value });
                      setAnchorError(null);
                    }}
                  />
                  <label htmlFor="anchor-max-offset">最大帧偏移（±帧）：</label>
                  <input
                    id="anchor-max-offset"
                    data-testid="anchor-max-offset"
                    type="text"
                    inputMode="numeric"
                    value={anchorInputs.maxOffsetFrames}
                    onChange={(e) => {
                      setAnchorInputs({
                        ...anchorInputs,
                        maxOffsetFrames: e.target.value
                      });
                      setAnchorError(null);
                    }}
                  />
                  <button
                    className="primary"
                    onClick={applyAlignment}
                    data-testid="apply-alignment"
                  >
                    对齐并比较
                  </button>
                </div>
                <div className="privacy-note">
                  锚点须为一段清晰的有效声音（至少 {MIN_ANCHOR_FRAMES} 帧）；
                  静音或能量不足不会强行对齐。偏移约定：返工[f+偏移]=基线[f]，
                  按最高相关度、最小绝对偏移、偏移为正的顺序确定唯一结果。
                </div>

                {(anchorError || rework.alignError) && (
                  <div className="view-error" data-testid="align-error">
                    {anchorError ?? rework.alignError}
                  </div>
                )}

                {reworkComparison && (
                  <div className="compare-summary" data-testid="rework-summary">
                    <div className="compare-verdicts">
                      <span className="compare-verdict-item">
                        唯一对齐偏移：
                        <span
                          className="compare-count"
                          data-testid="rework-offset"
                          data-sign={reworkComparison.alignment.sign}
                        >
                          {reworkComparison.alignment.sign === '+' ? '+' : ''}
                          {reworkComparison.alignment.offsetFrames} 帧
                        </span>
                      </span>
                      <span className="compare-verdict-item">
                        最高相关度 NCC：
                        <span className="compare-count" data-testid="rework-score">
                          {reworkComparison.alignment.bestScore.toFixed(5)}
                        </span>
                      </span>
                      <span className="compare-verdict-item">
                        锚点 RMS：
                        <span className="compare-count" data-testid="rework-rms">
                          {reworkComparison.alignment.anchorRms.toFixed(4)}
                        </span>
                      </span>
                      <span className="compare-verdict-item">
                        真实重叠帧：
                        <span className="compare-count" data-testid="rework-overlap">
                          {reworkComparison.overlapStartFrame}–
                          {reworkComparison.overlapEndExclusive - 1}
                          （{reworkComparison.overlapFrameCount} 帧）
                        </span>
                      </span>
                    </div>
                    <div className="diff-summary" data-testid="rework-diff-summary">
                      已修复 {reworkComparison.fixedCount} · 新增{' '}
                      {reworkComparison.newCount} · 共有 {reworkComparison.bothCount}
                      {' '}· 不可比较 {reworkComparison.incomparableFrames} 帧
                    </div>
                    {reworkComparison.hasRealDifference ? (
                      <div className="view-notice" data-testid="rework-real-diff">
                        重叠区内存在真实质量变化（已修复或新增削波），未覆盖区域已标记不可比较
                      </div>
                    ) : (
                      <div className="view-notice" data-testid="rework-no-real-diff">
                        重叠区内削波区间一致：差异仅来自录制起点错位
                      </div>
                    )}

                    <div className="legend rework-legend">
                      <span>
                        <span
                          className="swatch"
                          style={{ background: REWORK_MARK_COLORS.FIXED }}
                        />
                        已修复（重叠区仅基线）
                      </span>
                      <span>
                        <span
                          className="swatch"
                          style={{ background: REWORK_MARK_COLORS.NEW }}
                        />
                        返工新增（重叠区仅返工）
                      </span>
                      <span>
                        <span
                          className="swatch"
                          style={{ background: REWORK_MARK_COLORS.BOTH }}
                        />
                        两侧共有
                      </span>
                      <span>
                        <span
                          className="swatch"
                          style={{ background: REWORK_MARK_COLORS.BASELINE_ONLY }}
                        />
                        未覆盖区域（不可比较）
                      </span>
                    </div>
                  </div>
                )}

                {reworkComparison && (
                  <div className="rework-channels" data-testid="rework-channels">
                    {reworkComparison.channels.map((chDiff) => {
                      const baselineData =
                        loaded.result.channelData[chDiff.channel]!;
                      const reworkData =
                        rework.loaded!.result.channelData[chDiff.channel]!;
                      return (
                        <div
                          className="rework-channel-block"
                          key={chDiff.channel}
                          data-testid="rework-channel-block"
                          data-channel={chDiff.channel}
                        >
                          <h4>
                            {channelLabel(
                              chDiff.channel,
                              loaded.result.channels.length
                            )}
                          </h4>
                          <div className="rework-wave-row">
                            <div className="rework-wave-col">
                              <div className="rework-wave-caption">基线（原文件）</div>
                              <Waveform
                                data={baselineData}
                                sampleRate={loaded.result.sampleRate}
                                segments={
                                  loaded.result.channels[chDiff.channel]!.segments
                                }
                                positionSeconds={position}
                                viewRange={viewRange}
                                onSeek={seekTo}
                                marks={baselineWaveMarks(chDiff.segments)}
                              />
                            </div>
                            <div className="rework-wave-col">
                              <div className="rework-wave-caption">
                                返工（已按偏移对齐着色）
                              </div>
                              <Waveform
                                data={reworkData}
                                sampleRate={rework.loaded!.result.sampleRate}
                                segments={
                                  rework.loaded!.result.channels[chDiff.channel]!
                                    .segments
                                }
                                positionSeconds={reworkPosition}
                                viewRange={reworkViewRange ?? viewRange!}
                                onSeek={seekReworkAudio}
                                marks={reworkWaveMarks(chDiff.segments)}
                              />
                            </div>
                          </div>
                          <ReworkDiffList
                            segments={chDiff.segments}
                            onLocate={locateReworkSegment}
                          />
                        </div>
                      );
                    })}
                    <audio
                      ref={reworkAudioRef}
                      controls
                      src={rework.loaded.objectUrl}
                      data-testid="rework-audio-player"
                      onTimeUpdate={(e) =>
                        setReworkPosition(e.currentTarget.currentTime)
                      }
                    />
                  </div>
                )}
              </>
            )}
          </section>

          {loaded.result.channels.map((ch) => (
            <section
              className="channel-card"
              key={ch.channel}
              data-testid="channel-card"
              data-channel={ch.channel}
            >
              <div className="channel-head">
                <h3>{channelLabel(ch.channel, loaded.result.channels.length)}</h3>
                <span
                  className={`channel-stat ${ch.segments.length > 0 ? 'clip-present' : ''}`}
                  data-testid="channel-stat"
                >
                  {ch.segments.length === 0
                    ? '无削波段'
                    : `${ch.segments.length} 段 · 合计 ${ch.totalClipMs} ms`}
                </span>
              </div>
              <Waveform
                data={loaded.result.channelData[ch.channel]!}
                sampleRate={loaded.result.sampleRate}
                segments={ch.segments}
                positionSeconds={position}
                viewRange={viewRange}
                onSeek={seekTo}
                diffs={comparison?.channels[ch.channel]?.segments}
              />
              <div className="legend">
                <span>
                  <span className="swatch" style={{ background: '#6ea8fe' }} />
                  波形
                </span>
                <span>
                  <span className="swatch" style={{ background: 'rgba(255,77,79,0.5)' }} />
                  削波高亮
                </span>
                <span>
                  <span className="swatch" style={{ background: '#ffd34d' }} />
                  当前播放位置
                </span>
                {comparison && (
                  <>
                    <span>
                      <span
                        className="swatch"
                        style={{ background: DIFF_STRIPE_COLORS.BASELINE_ONLY }}
                      />
                      仅基线（新规则漏掉）
                    </span>
                    <span>
                      <span
                        className="swatch"
                        style={{ background: DIFF_STRIPE_COLORS.CANDIDATE_ONLY }}
                      />
                      仅候选（新规则新增）
                    </span>
                    <span>
                      <span
                        className="swatch"
                        style={{ background: DIFF_STRIPE_COLORS.BOTH }}
                      />
                      两者共有
                    </span>
                  </>
                )}
              </div>
              <SegmentList segments={ch.segments} onLocate={locateSegment} />
              {comparison && (
                <div className="diff-section">
                  <h4>
                    差异片段（候选{' '}
                    {comparison.candidate.channels[ch.channel]!.segments.length}{' '}
                    段 vs 基线 {ch.segments.length} 段）
                  </h4>
                  <DiffList
                    segments={comparison.channels[ch.channel]!.segments}
                    onLocate={locateSegment}
                  />
                </div>
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
