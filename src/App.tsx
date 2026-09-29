import { useEffect, useRef, useState } from 'react';
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
  alignmentErrorMessage,
  alignByAnchor,
  parseAnchorInput,
  type AnchorError
} from './audio/alignment';
import {
  ReworkMismatchError,
  buildReworkComparison,
  type ReworkComparison,
  type ReworkDiffSegment
} from './audio/rework-compare';
import {
  INVALID_WINDOW_NOTICE,
  SHORT_RECORDING_NOTICE,
  fullTrackRange,
  localViewRange,
  parseWindowSeconds,
  type ViewRange
} from './audio/view-range';
import Waveform, { DIFF_STRIPE_COLORS, REWORK_STRIPE_COLORS } from './components/Waveform';
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

/** 返工对照锚点输入默认值：起点 0s、长度 0.5s、±80 帧、声道 0 */
const DEFAULT_ANCHOR_INPUTS = {
  startSeconds: '0',
  lengthSeconds: '0.5',
  maxOffsetFrames: '80',
  channel: '0'
};

/** 偏移展示：正数加 +，负数用真正的减号 −（非连字符） */
function formatOffset(frames: number): string {
  return (frames > 0 ? '+' : '') + String(frames).replace('-', '−');
}

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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  // ── 返工文件对照 ───────────────────────────────────────────────
  // reworkLoaded：已确认载入的返工扫描；reworkComparison：已确认的对照
  // （差异表/双波形/试听共用同一对象，单次 setState 原子生效）。
  // 解码/对齐是异步的：baseToken / reworkToken 单调递增，
  // 迟到结果只在令牌仍最新时提交，不能覆盖更新的文件。
  const [reworkStatus, setReworkStatus] = useState<Status>('idle');
  const [reworkLoaded, setReworkLoaded] = useState<LoadedWav | null>(null);
  const [reworkError, setReworkError] = useState<ErrorState | null>(null);
  const [anchorInputs, setAnchorInputs] = useState(DEFAULT_ANCHOR_INPUTS);
  const [anchorError, setAnchorError] = useState<string | null>(null);
  const [reworkComparison, setReworkComparison] =
    useState<ReworkComparison | null>(null);
  const [reworkBusy, setReworkBusy] = useState(false);
  const [reworkPosition, setReworkPosition] = useState(0);
  const reworkAudioRef = useRef<HTMLAudioElement | null>(null);
  const reworkObjectUrlRef = useRef<string | null>(null);
  const baseTokenRef = useRef(0);
  const reworkTokenRef = useRef(0);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      if (reworkObjectUrlRef.current) URL.revokeObjectURL(reworkObjectUrlRef.current);
    };
  }, []);

  const handleFile = async (file: File | null | undefined) => {
    if (!file) return;
    // 新基线一旦开始载入，旧基线与旧返工对照全部作废；
    // 令牌立即推进，任何迟到的旧解码/对齐结果都不再可提交
    const token = ++baseTokenRef.current;
    reworkTokenRef.current++;
    setStatus('loading');
    setError(null);
    try {
      const next = await loadAndScanWav(file);
      if (token !== baseTokenRef.current) {
        // 载入期间又选了更新的文件：放弃本次结果，释放它独占的对象 URL
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
      // 新基线载入：返工对照必须清空（旧对照引用旧基线 PCM）
      resetReworkState();
      setStatus('done');
    } catch (err) {
      if (token !== baseTokenRef.current) return;
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
      // 基线解码失败：无有效基线，返工对照一并清空
      resetReworkState();
      setStatus('error');
    }
  };

  /**
   * 清空全部返工对照状态并释放返工对象 URL。
   * 新基线载入、基线解码失败或手动移除返工时调用。
   */
  const resetReworkState = () => {
    reworkTokenRef.current++;
    if (reworkObjectUrlRef.current) {
      URL.revokeObjectURL(reworkObjectUrlRef.current);
      reworkObjectUrlRef.current = null;
    }
    setReworkLoaded(null);
    setReworkComparison(null);
    setReworkError(null);
    setAnchorError(null);
    setAnchorInputs(DEFAULT_ANCHOR_INPUTS);
    setReworkBusy(false);
    setReworkStatus('idle');
    setReworkPosition(0);
  };

  /**
   * 载入返工文件：
   * - 返工解码失败时【保留已确认的旧对照】，不清空 reworkComparison / reworkLoaded；
   * - 载入成功即旧对照失效（PCM 已换），清空对照等待重新对齐；
   * - 迟到的解码结果不能覆盖更新的选择（令牌校验）。
   */
  const handleReworkFile = async (file: File | null | undefined) => {
    if (!file) return;
    if (!loaded) return;
    const token = ++reworkTokenRef.current;
    setReworkStatus('loading');
    setReworkError(null);
    setReworkBusy(false);
    try {
      const next = await loadAndScanWav(file);
      if (token !== reworkTokenRef.current) {
        URL.revokeObjectURL(next.objectUrl);
        return;
      }
      if (reworkObjectUrlRef.current) URL.revokeObjectURL(reworkObjectUrlRef.current);
      reworkObjectUrlRef.current = next.objectUrl;
      setReworkLoaded(next);
      setReworkPosition(0);
      // 新返工 PCM：旧对照的偏移与片段数组基于旧文件，必须清空
      setReworkComparison(null);
      setAnchorError(null);
      setReworkStatus('done');
    } catch (err) {
      if (token !== reworkTokenRef.current) return;
      // 解码失败：保留已确认的旧对照与旧返工文件，仅就地报错
      const state: ErrorState =
        err instanceof WavError
          ? { code: err.code, title: ERROR_MESSAGES[err.code], detail: err.message }
          : {
              code: 'SCAN_FAILED',
              title: ERROR_MESSAGES.DECODE_FAILED,
              detail: `返工文件扫描过程中发生错误：${
                err instanceof Error ? err.message : String(err)
              }`
            };
      setReworkError(state);
      setReworkStatus('error');
    }
  };

  /**
   * 应用锚点对齐并建立返工对照：
   * - 输入非法 / 锚点静音或能量不足 / 采样率声道不一致：就地提示，保留上一次对照；
   * - 对齐与切片为同步纯计算（在已解码 PCM 上），但仍以令牌守卫，
   *   避免与快速换文件竞争；迟到结果不得覆盖较新文件。
   */
  const applyReworkAlignment = () => {
    if (!loaded || !reworkLoaded) return;
    const token = reworkTokenRef.current;
    // 捕获当前已确认的两份扫描：setTimeout 回调执行时状态可能已切换，
    // 令牌会拦截过期回调，未过期时这两个引用正是本次对齐对象
    const baselineResult = loaded.result;
    const reworkResult = reworkLoaded.result;
    const anchor = parseAnchorInput(
      anchorInputs,
      baselineResult.sampleRate,
      baselineResult.channels.length
    );
    if (anchor === null) {
      setAnchorError(INVALID_ANCHOR_NOTICE);
      return;
    }
    const baseData = baselineResult.channelData[anchor.channel];
    const reworkData = reworkResult.channelData[anchor.channel];
    if (!baseData || !reworkData) {
      setAnchorError('对齐声道在已解码 PCM 中不存在，无法对齐');
      return;
    }
    setReworkBusy(true);
    // 让“正在对齐”状态先上屏；计算推迟一个任务，与将来的异步相关计算
    // 走同一条令牌守卫路径（迟到结果不能覆盖较新文件）
    setTimeout(() => {
      if (token !== reworkTokenRef.current) return;
      const aligned = alignByAnchor(baseData, reworkData, anchor);
      if ('kind' in aligned) {
        const err: AnchorError = aligned;
        // 静音 / 能量不足 / 参数问题：不强行对齐，保留上一次已确认对照
        setAnchorError(alignmentErrorMessage(err));
        setReworkBusy(false);
        return;
      }
      try {
        const next = buildReworkComparison(
          baselineResult,
          reworkResult,
          anchor,
          aligned
        );
        setReworkComparison(next);
        setAnchorError(null);
      } catch (e) {
        if (e instanceof ReworkMismatchError) {
          setAnchorError(e.message);
        } else {
          setAnchorError(
            `返工对照构建失败：${e instanceof Error ? e.message : String(e)}`
          );
        }
      } finally {
        setReworkBusy(false);
      }
    }, 0);
  };

  /** 返工对照定位试听：同一差异片段分别映射回原件 / 返工件时间轴 */
  const seekReworkSide = (
    seg: ReworkDiffSegment,
    side: 'baseline' | 'rework'
  ) => {
    const seconds =
      side === 'baseline' ? seg.baselineStartSeconds : seg.reworkStartSeconds;
    if (seconds === null) return;
    if (side === 'baseline') {
      seekTo(seconds);
      focusLocalView(seconds, windowSeconds);
      return;
    }
    const audio = reworkAudioRef.current;
    if (!audio || !reworkLoaded) return;
    const clamped = Math.min(
      reworkLoaded.result.durationSeconds,
      Math.max(0, seconds)
    );
    audio.currentTime = clamped;
    setReworkPosition(clamped);
    void audio.play().catch(() => {
      /* 浏览器拦截自动播放时保持定位即可 */
    });
  };

  /** 差异表行：两侧播放器同步跳到该片段各自坐标；只一侧存在的片段跳存在侧 */
  const locateReworkSegment = (seg: ReworkDiffSegment) => {
    seekReworkSide(seg, 'baseline');
    seekReworkSide(seg, 'rework');
  };

  /** 点击返工波形：仅定位返工播放器（返工自身时间轴） */
  const seekReworkSeconds = (seconds: number) => {
    const audio = reworkAudioRef.current;
    if (!audio || !reworkLoaded) return;
    const clamped = Math.min(
      reworkLoaded.result.durationSeconds,
      Math.max(0, seconds)
    );
    audio.currentTime = clamped;
    setReworkPosition(clamped);
    void audio.play().catch(() => {
      /* 浏览器拦截自动播放时保持定位即可 */
    });
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
            <h2 className="compare-title">返工文件对照（先对齐再裁决，不改动上方基线结论）</h2>
            <p className="privacy-note" style={{ marginBottom: 12 }}>
              选取原件中一段<strong>有效声音</strong>作锚点，在限定帧偏移内对两份已解码
              PCM 做归一化互相关，按“最高相关度 → 最小绝对偏移 → 负偏移优先”确定唯一对齐。
              静音或能量不足的锚点不会强行对齐；两份扫描只在真实重叠的原始帧范围内比较，
              未覆盖区域标记为不可比较。文件全程不离开本机。
            </p>
            <div className="compare-controls">
              <label htmlFor="rework-input">返工 WAV：</label>
              <input
                id="rework-input"
                data-testid="rework-input"
                type="file"
                accept=".wav,audio/wav,audio/x-wav,audio/wave"
                onChange={(e) => void handleReworkFile(e.target.files?.[0])}
              />
              {reworkStatus === 'loading' && (
                <span className="loading" data-testid="rework-loading">
                  正在本地解码返工文件…
                </span>
              )}
              {reworkLoaded && (
                <button
                  onClick={resetReworkState}
                  data-testid="clear-rework"
                >
                  移除返工文件
                </button>
              )}
            </div>
            {reworkStatus === 'error' && reworkError && (
              <div className="view-error" data-testid="rework-error" style={{ marginTop: 8 }}>
                [{reworkError.code}] {reworkError.title}：{reworkError.detail}
                {reworkComparison && (
                  <div style={{ color: 'var(--warn)', marginTop: 4 }}>
                    已保留此前确认的对照结果，未被本次失败覆盖。
                  </div>
                )}
              </div>
            )}

            {reworkLoaded && (
              <>
                <div className="rework-meta" data-testid="rework-meta">
                  返工文件：{reworkLoaded.result.fileName} ·{' '}
                  {reworkLoaded.result.sampleRate} Hz ·{' '}
                  {reworkLoaded.result.channels.length} 声道 ·{' '}
                  {formatSeconds(reworkLoaded.result.durationSeconds)} s ·{' '}
                  {reworkLoaded.result.channels.reduce(
                    (n, c) => n + c.segments.length,
                    0
                  )}{' '}
                  段
                </div>
                <div className="compare-controls" style={{ marginTop: 10 }}>
                  <label htmlFor="anchor-start">锚点起点（秒）：</label>
                  <input
                    id="anchor-start"
                    data-testid="anchor-start"
                    type="text"
                    inputMode="decimal"
                    value={anchorInputs.startSeconds}
                    onChange={(e) => {
                      setAnchorInputs({ ...anchorInputs, startSeconds: e.target.value });
                      setAnchorError(null);
                    }}
                  />
                  <label htmlFor="anchor-length">锚点长度（秒）：</label>
                  <input
                    id="anchor-length"
                    data-testid="anchor-length"
                    type="text"
                    inputMode="decimal"
                    value={anchorInputs.lengthSeconds}
                    onChange={(e) => {
                      setAnchorInputs({ ...anchorInputs, lengthSeconds: e.target.value });
                      setAnchorError(null);
                    }}
                  />
                  <label htmlFor="anchor-max-offset">限定帧偏移（±帧）：</label>
                  <input
                    id="anchor-max-offset"
                    data-testid="anchor-max-offset"
                    type="text"
                    inputMode="numeric"
                    value={anchorInputs.maxOffsetFrames}
                    onChange={(e) => {
                      setAnchorInputs({ ...anchorInputs, maxOffsetFrames: e.target.value });
                      setAnchorError(null);
                    }}
                  />
                  <label htmlFor="anchor-channel">对齐声道：</label>
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
                  <button
                    className="primary"
                    onClick={applyReworkAlignment}
                    data-testid="apply-anchor"
                    disabled={reworkBusy}
                  >
                    {reworkBusy ? '对齐计算中…' : '对齐并对照'}
                  </button>
                </div>
                {anchorError && (
                  <div className="view-error" data-testid="anchor-error" style={{ marginTop: 8 }}>
                    {anchorError}
                  </div>
                )}

                {reworkComparison && (
                  <div className="compare-summary" data-testid="rework-summary">
                    <div className="rework-alignment" data-testid="rework-alignment">
                      唯一对齐偏移：
                      <strong data-testid="rework-offset">
                        {formatOffset(reworkComparison.alignment.offsetFrames)} 帧
                      </strong>
                      （返工帧 = 原件帧{' '}
                      {reworkComparison.alignment.offsetFrames >= 0
                        ? `+ ${reworkComparison.alignment.offsetFrames}`
                        : `− ${Math.abs(reworkComparison.alignment.offsetFrames)}`}
                      ）· 归一化相关度{' '}
                      {reworkComparison.alignment.score.toFixed(4)} · 锚点 RMS{' '}
                      {reworkComparison.alignment.anchorRms.toFixed(4)} ·{' '}
                      {reworkComparison.alignment.comparedFrames} 帧参与相关
                    </div>
                    <div className="diff-summary" data-testid="rework-counts">
                      {`已修复（仅原件）${reworkComparison.fixedCount} · 新引入（仅返工）${reworkComparison.introducedCount} · 仍削波（两边共有）${reworkComparison.remainingCount} · 不可比较 ${reworkComparison.uncomparedCount}`}
                    </div>
                    <audio
                      ref={reworkAudioRef}
                      controls
                      src={reworkLoaded.objectUrl}
                      data-testid="rework-audio-player"
                      onTimeUpdate={(e) => setReworkPosition(e.currentTarget.currentTime)}
                    />
                  </div>
                )}
              </>
            )}
          </section>

          {reworkComparison && (
            <section className="panel" data-testid="rework-dual-panel">
              <h2 className="compare-title">双波形与差异片段（偏移与片段数组共用）</h2>
              <div className="legend" style={{ marginBottom: 10 }}>
                <span>
                  <span
                    className="swatch"
                    style={{ background: REWORK_STRIPE_COLORS.BASELINE_ONLY }}
                  />
                  仅原件（返工已修复）
                </span>
                <span>
                  <span
                    className="swatch"
                    style={{ background: REWORK_STRIPE_COLORS.REWORK_ONLY }}
                  />
                  仅返工件（新引入）
                </span>
                <span>
                  <span
                    className="swatch"
                    style={{ background: REWORK_STRIPE_COLORS.BOTH }}
                  />
                  两边仍削波（未修复）
                </span>
                <span>
                  <span
                    className="swatch"
                    style={{ background: REWORK_STRIPE_COLORS.BASELINE_UNCOMPARED }}
                  />
                  原件超出重叠（不可比较）
                </span>
                <span>
                  <span
                    className="swatch"
                    style={{ background: REWORK_STRIPE_COLORS.REWORK_UNCOMPARED }}
                  />
                  返工超出重叠（不可比较）
                </span>
              </div>
              {loaded.result.channels.map((bch) => {
                const rch = reworkComparison!.rework.channels[bch.channel]!;
                const channelDiffs = reworkComparison!.channels[bch.channel]!;
                const stripes = channelDiffs.segments.map((seg) => ({
                  ...seg,
                  source: 'rework' as const
                }));
                return (
                  <div
                    className="rework-channel"
                    key={`rework-${bch.channel}`}
                    data-testid="rework-channel"
                    data-channel={bch.channel}
                  >
                    <div className="channel-head">
                      <h3>{channelLabel(bch.channel, loaded.result.channels.length)}</h3>
                      <span className="channel-stat">
                        重叠（原件帧）：
                        {channelDiffs.overlapBaseline
                          ? `${channelDiffs.overlapBaseline.startFrame}–${channelDiffs.overlapBaseline.endFrame}`
                          : '无真实重叠'}
                      </span>
                    </div>
                    <div className="rework-wave-row">
                      <div className="rework-wave-col">
                        <div className="rework-wave-label">原件（基线）</div>
                        <Waveform
                          data={loaded.result.channelData[bch.channel]!}
                          sampleRate={loaded.result.sampleRate}
                          segments={bch.segments}
                          positionSeconds={position}
                          viewRange={fullTrackRange(loaded.result.durationSeconds)}
                          onSeek={(sec) => seekTo(sec)}
                          stripes={stripes}
                          stripeSide="baseline"
                        />
                      </div>
                      <div className="rework-wave-col">
                        <div className="rework-wave-label">返工件（已按偏移映射对着色）</div>
                        <Waveform
                          data={reworkComparison!.rework.channelData[bch.channel]!}
                          sampleRate={reworkComparison!.rework.sampleRate}
                          segments={rch.segments}
                          positionSeconds={reworkPosition}
                          viewRange={fullTrackRange(reworkComparison!.rework.durationSeconds)}
                          onSeek={(sec) => seekReworkSeconds(sec)}
                          stripes={stripes}
                          stripeSide="rework"
                        />
                      </div>
                    </div>
                    <ReworkDiffList
                      segments={channelDiffs.segments}
                      onLocate={locateReworkSegment}
                    />
                  </div>
                );
              })}
            </section>
          )}

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
