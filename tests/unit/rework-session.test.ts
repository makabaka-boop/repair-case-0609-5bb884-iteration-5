import { describe, expect, it } from 'vitest';
import {
  initialReworkSession,
  isStaleResult,
  makeAlignedSession,
  reworkSessionReducer
} from '../../src/audio/rework-session';
import type { LoadedWav } from '../../src/audio/decoder';
import type {
  AlignedResult,
  ReworkComparison
} from '../../src/audio/rework';
import type { ScanResult } from '../../src/audio/types';

const fakeScan = (name: string): ScanResult =>
  ({
    fileName: name,
    sampleRate: 8000,
    channels: [],
    totalClipSeconds: 0,
    totalClipMs: 0,
    hasClip: false,
    firstClip: null,
    channelData: [],
    durationSeconds: 1
  }) as ScanResult;

const fakeLoaded = (name: string, url: string): LoadedWav => ({
  result: fakeScan(name),
  objectUrl: url
});

const aligned = (offsetFrames: number): AlignedResult => ({
  status: 'aligned',
  offsetFrames,
  sign: offsetFrames > 0 ? '+' : offsetFrames < 0 ? '-' : '0',
  bestScore: 0.99,
  candidateCount: 41,
  channel: 0,
  anchorStartFrame: 100,
  anchorFrameCount: 80,
  anchorRms: 0.2,
  maxOffsetFrames: 200
});

const fakeComparison = (offsetFrames: number): ReworkComparison =>
  ({
    baseline: fakeScan('b.wav'),
    rework: fakeScan('r.wav'),
    rule: { threshold: 0.999, minRunFrames: 3, maxMergeGap: 2 },
    alignment: aligned(offsetFrames),
    overlapStartFrame: 0,
    overlapEndExclusive: 100,
    overlapFrameCount: 100,
    channels: [],
    fixedCount: 0,
    newCount: 0,
    bothCount: 0,
    baselineOnlyCount: 0,
    reworkOnlyCount: 0,
    incomparableFrames: 0,
    hasRealDifference: false
  }) as ReworkComparison;

const loadError = (code = 'CORRUPT') => ({
  code,
  title: '损坏',
  detail: 'detail'
});

describe('isStaleResult 序号裁决', () => {
  it('结果序号小于当前值即迟到，必须丢弃', () => {
    expect(isStaleResult(5, 4)).toBe(true);
    expect(isStaleResult(5, 5)).toBe(false);
    expect(isStaleResult(0, 0)).toBe(false);
  });
});

describe('返工会话状态机', () => {
  it('初始为 idle', () => {
    expect(initialReworkSession).toMatchObject({
      status: 'idle',
      loaded: null,
      comparison: null,
      gen: 0
    });
  });

  it('新基线载入：清空全部返工状态并采用新序号', () => {
    const withComparison = makeAlignedSession({
      gen: 3,
      loaded: fakeLoaded('r.wav', 'blob:r'),
      comparison: fakeComparison(12)
    });
    const next = reworkSessionReducer(withComparison, {
      type: 'baseline-changed',
      gen: 4
    });
    expect(next.status).toBe('idle');
    expect(next.loaded).toBeNull();
    expect(next.comparison).toBeNull();
    expect(next.alignment).toBeNull();
    expect(next.gen).toBe(4);
  });

  it('选择返工：进入 loading，gen 推进，旧对照暂存（等待解码结果）', () => {
    const withComparison = makeAlignedSession({
      gen: 1,
      loaded: fakeLoaded('old.wav', 'blob:old'),
      comparison: fakeComparison(5)
    });
    const next = reworkSessionReducer(withComparison, {
      type: 'rework-selected',
      gen: 2
    });
    expect(next.status).toBe('loading');
    // 旧 loaded/对照暂存：解码失败时要能回到旧对照
    expect(next.loaded?.result.fileName).toBe('old.wav');
    expect(next.comparison).not.toBeNull();
    expect(next.gen).toBe(2);
  });

  it('返工解码成功：新 loaded 生效，旧对照清空', () => {
    const loading = reworkSessionReducer(
      makeAlignedSession({
        gen: 1,
        loaded: fakeLoaded('old.wav', 'blob:old'),
        comparison: fakeComparison(5)
      }),
      { type: 'rework-selected', gen: 2 }
    );
    const nextLoaded = fakeLoaded('new.wav', 'blob:new');
    const next = reworkSessionReducer(loading, {
      type: 'rework-loaded',
      gen: 2,
      loaded: nextLoaded
    });
    expect(next.status).toBe('ready');
    expect(next.loaded).toBe(nextLoaded);
    expect(next.comparison).toBeNull();
    expect(next.alignment).toBeNull();
    expect(next.loadError).toBeNull();
  });

  it('返工解码失败：保留已确认旧对照与旧返工，仅报错，状态回到 aligned', () => {
    const oldLoaded = fakeLoaded('old.wav', 'blob:old');
    const oldComparison = fakeComparison(7);
    const loading = reworkSessionReducer(
      makeAlignedSession({ gen: 1, loaded: oldLoaded, comparison: oldComparison }),
      { type: 'rework-selected', gen: 2 }
    );
    const next = reworkSessionReducer(loading, {
      type: 'rework-failed',
      gen: 2,
      error: loadError()
    });
    expect(next.status).toBe('aligned');
    expect(next.loaded).toBe(oldLoaded);
    expect(next.comparison).toBe(oldComparison);
    expect(next.loadError).toMatchObject({ code: 'CORRUPT' });
  });

  it('解码失败且此前没有旧对照：状态回到 idle/ready，不产生对照', () => {
    const next = reworkSessionReducer(
      { ...initialReworkSession, status: 'loading', gen: 1 },
      { type: 'rework-failed', gen: 1, error: loadError('NOT_WAV') }
    );
    expect(next.status).toBe('idle');
    expect(next.comparison).toBeNull();
    expect(next.loadError).toMatchObject({ code: 'NOT_WAV' });

    const loaded = fakeLoaded('ok.wav', 'blob:ok');
    const ready = reworkSessionReducer(
      {
        ...initialReworkSession,
        status: 'loading',
        loaded,
        gen: 2
      },
      { type: 'rework-failed', gen: 2, error: loadError() }
    );
    expect(ready.status).toBe('ready');
    expect(ready.loaded).toBe(loaded);
    expect(ready.comparison).toBeNull();
  });

  it('对齐成功：建立对照并进入 aligned', () => {
    const loaded = fakeLoaded('r.wav', 'blob:r');
    const state = {
      ...initialReworkSession,
      status: 'ready' as const,
      loaded,
      gen: 2
    };
    const comparison = fakeComparison(10);
    const next = reworkSessionReducer(state, {
      type: 'alignment-settled',
      gen: 2,
      result: aligned(10),
      comparison
    });
    expect(next.status).toBe('aligned');
    expect(next.comparison).toBe(comparison);
    expect(next.alignment).toEqual(aligned(10));
    expect(next.alignError).toBeNull();
  });

  it('对齐失败（弱锚点等）：不覆盖已确认对照，仅就地提示', () => {
    const oldComparison = fakeComparison(4);
    const state = makeAlignedSession({
      gen: 2,
      loaded: fakeLoaded('r.wav', 'blob:r'),
      comparison: oldComparison
    });
    const next = reworkSessionReducer(state, {
      type: 'alignment-settled',
      gen: 2,
      result: {
        status: 'failed',
        reason: 'weak-anchor',
        message: '锚点能量不足'
      },
      comparison: null
    });
    expect(next.status).toBe('aligned');
    expect(next.comparison).toBe(oldComparison);
    expect(next.alignError).toBe('锚点能量不足');
    expect(next.alignment).toMatchObject({ status: 'failed', reason: 'weak-anchor' });
  });

  it('对齐失败且无旧对照：保持 ready，仅提示', () => {
    const state = {
      ...initialReworkSession,
      status: 'ready' as const,
      loaded: fakeLoaded('r.wav', 'blob:r'),
      gen: 1
    };
    const next = reworkSessionReducer(state, {
      type: 'alignment-settled',
      gen: 1,
      result: { status: 'failed', reason: 'no-overlap', message: '无重叠' },
      comparison: null
    });
    expect(next.status).toBe('ready');
    expect(next.comparison).toBeNull();
    expect(next.alignError).toBe('无重叠');
  });
});

describe('快速换文件：迟到结果的状态隔离', () => {
  it('旧返工的迟到解码成功结果不覆盖新选择（同一引用返回）', () => {
    // gen=1 选择 r1 且在 loading；用户立刻改选 r2（gen=2）
    const loading1 = reworkSessionReducer(initialReworkSession, {
      type: 'rework-selected',
      gen: 1
    });
    const loading2 = reworkSessionReducer(loading1, {
      type: 'rework-selected',
      gen: 2
    });
    // r1 的解码此刻才回来（gen=1）→ 必须原样丢弃
    const stale = reworkSessionReducer(loading2, {
      type: 'rework-loaded',
      gen: 1,
      loaded: fakeLoaded('r1.wav', 'blob:r1')
    });
    expect(stale).toBe(loading2);
    expect(stale.loaded).toBeNull();
    expect(stale.gen).toBe(2);

    // r2 的解码结果（gen=2）正常生效
    const done = reworkSessionReducer(stale, {
      type: 'rework-loaded',
      gen: 2,
      loaded: fakeLoaded('r2.wav', 'blob:r2')
    });
    expect(done.status).toBe('ready');
    expect(done.loaded?.result.fileName).toBe('r2.wav');
  });

  it('旧返工的迟到解码失败结果同样不覆盖新状态', () => {
    const loading2 = reworkSessionReducer(
      reworkSessionReducer(initialReworkSession, {
        type: 'rework-selected',
        gen: 1
      }),
      { type: 'rework-selected', gen: 2 }
    );
    const stale = reworkSessionReducer(loading2, {
      type: 'rework-failed',
      gen: 1,
      error: loadError()
    });
    expect(stale).toBe(loading2);
    expect(stale.loadError).toBeNull();
  });

  it('迟到的对齐结果不覆盖已更换的文件（gen 已推进）', () => {
    const r2 = fakeLoaded('r2.wav', 'blob:r2');
    const ready = {
      ...initialReworkSession,
      status: 'ready' as const,
      loaded: r2,
      gen: 2
    };
    // 旧会话 gen=1 的对齐结果迟到 → 丢弃
    const stale = reworkSessionReducer(ready, {
      type: 'alignment-settled',
      gen: 1,
      result: aligned(30),
      comparison: fakeComparison(30)
    });
    expect(stale).toBe(ready);
    expect(stale.comparison).toBeNull();
  });

  it('新基线的迟到 baseline-changed 也被更高序号隔离', () => {
    const state = makeAlignedSession({
      gen: 5,
      loaded: fakeLoaded('r.wav', 'blob:r'),
      comparison: fakeComparison(9)
    });
    const stale = reworkSessionReducer(state, {
      type: 'baseline-changed',
      gen: 4
    });
    expect(stale).toBe(state);
    expect(stale.comparison).not.toBeNull();
  });

  it('完整快速切换序列：失败→成功→换文件→旧失败迟到，均不串状态', () => {
    let s = reworkSessionReducer(initialReworkSession, {
      type: 'rework-selected',
      gen: 1
    });
    // r1 失败：idle + 报错
    s = reworkSessionReducer(s, {
      type: 'rework-failed',
      gen: 1,
      error: loadError('CORRUPT')
    });
    expect(s.status).toBe('idle');
    expect(s.loadError).not.toBeNull();

    // 立刻选择 r2（gen=2），错误清除进入 loading
    s = reworkSessionReducer(s, { type: 'rework-selected', gen: 2 });
    expect(s.status).toBe('loading');
    expect(s.loadError).toBeNull();

    // r1 的某种迟到失败（gen=1）回来 → 丢弃
    const before = s;
    s = reworkSessionReducer(s, {
      type: 'rework-failed',
      gen: 1,
      error: loadError('DECODE_FAILED')
    });
    expect(s).toBe(before);

    // r2 成功
    const r2 = fakeLoaded('r2.wav', 'blob:r2');
    s = reworkSessionReducer(s, {
      type: 'rework-loaded',
      gen: 2,
      loaded: r2
    });
    expect(s.status).toBe('ready');
    expect(s.loaded).toBe(r2);

    // r2 对齐成功
    const cmp = fakeComparison(15);
    s = reworkSessionReducer(s, {
      type: 'alignment-settled',
      gen: 2,
      result: aligned(15),
      comparison: cmp
    });
    expect(s.status).toBe('aligned');
    expect(s.comparison).toBe(cmp);
  });
});
