/**
 * 返工对照会话状态机（纯 reducer）。
 *
 * 页面上的返工对照生命周期由本模块唯一裁决，React 只负责派发与渲染：
 * - 返工文件解码【失败】时保留已确认的旧对照（连同旧返工载入），仅就地报错；
 * - 返工文件【成功】载入即清空旧对照（它基于另一份返工 PCM）；
 * - 新基线载入（resetForBaseline）清空全部返工状态；
 * - 迟到的解码或对齐结果带单调序号 gen，gen 较小时 reducer 返回【同一旧状态】，
 *   绝不覆盖较新的文件选择与对照结果；
 * - 对齐失败（弱锚点/无重叠/格式不一致等）不覆盖已确认的对照，仅就地提示。
 */

import type { AlignmentResult } from './rework';
import type { LoadedWav } from './decoder';
import type { ReworkComparison } from './rework';

/** 返工解码失败的原因与提示（结构校验/解码错误由页面从 WavError 映射） */
export interface ReworkLoadError {
  code: string;
  title: string;
  detail: string;
}

export type ReworkStatus =
  | 'idle' // 未选择返工文件
  | 'loading' // 已选择，结构校验/解码进行中
  | 'ready' // 返工已解码，尚未建立或未成功建立对照
  | 'aligned'; // 已确认对照（comparison 可用）

export interface ReworkSessionState {
  status: ReworkStatus;
  /** 当前已确认载入的返工（解码失败时保留旧值） */
  loaded: LoadedWav | null;
  loadError: ReworkLoadError | null;
  /** 已确认的对照；载入新返工或新基线时清空，失败不清空 */
  comparison: ReworkComparison | null;
  /** 最近一次对齐裁决（成功或失败），用于展示相关度/偏移或就地提示 */
  alignment: AlignmentResult | null;
  alignError: string | null;
  /** 当前文件选择的单调序号：迟到结果的 gen 小于它时一律丢弃 */
  gen: number;
}

export const initialReworkSession: ReworkSessionState = {
  status: 'idle',
  loaded: null,
  loadError: null,
  comparison: null,
  alignment: null,
  alignError: null,
  gen: 0
};

export type ReworkSessionAction =
  | { type: 'baseline-changed'; gen: number }
  | { type: 'rework-selected'; gen: number }
  | { type: 'rework-loaded'; gen: number; loaded: LoadedWav }
  | { type: 'rework-failed'; gen: number; error: ReworkLoadError }
  | {
      type: 'alignment-settled';
      gen: number;
      result: AlignmentResult;
      comparison: ReworkComparison | null;
    };

/**
 * 判断迟到结果是否已被更新的文件选择取代。
 * 解码/对齐异步完成时调用；为 true 时调用方必须原样保留当前状态。
 */
export function isStaleResult(
  currentGen: number,
  resultGen: number
): boolean {
  return resultGen < currentGen;
}

/**
 * 会话状态机。任何 action 的 gen 小于当前 gen 都视为迟到结果，
 * 返回与传入完全相同的状态引用（React 据此跳过重渲染，旧数据无法覆盖新文件）。
 */
export function reworkSessionReducer(
  state: ReworkSessionState,
  action: ReworkSessionAction
): ReworkSessionState {
  if (isStaleResult(state.gen, action.gen)) {
    return state;
  }

  switch (action.type) {
    case 'baseline-changed':
      // 新基线载入：返工对照依赖基线 PCM，全部清空
      return {
        ...initialReworkSession,
        gen: action.gen
      };

    case 'rework-selected':
      // 新返工开始加载：保留旧 loaded/comparison（解码失败时要能回到旧对照），
      // 仅标记 loading；gen 已推进，旧请求的迟到结果之后会被丢弃。
      return {
        ...state,
        status: 'loading',
        loadError: null,
        alignError: null,
        gen: action.gen
      };

    case 'rework-loaded':
      // 新返工成功载入：旧对照基于另一份返工 PCM，必须清空
      return {
        ...state,
        status: 'ready',
        loaded: action.loaded,
        loadError: null,
        comparison: null,
        alignment: null,
        alignError: null,
        gen: action.gen
      };

    case 'rework-failed':
      // 解码失败：保留已确认的旧对照与旧返工载入，状态恢复到其已确认形态
      return {
        ...state,
        status: state.comparison !== null ? 'aligned' : state.loaded !== null ? 'ready' : 'idle',
        loadError: action.error,
        gen: action.gen
      };

    case 'alignment-settled': {
      if (action.result.status === 'aligned' && action.comparison !== null) {
        return {
          ...state,
          status: 'aligned',
          alignment: action.result,
          comparison: action.comparison,
          alignError: null,
          gen: action.gen
        };
      }
      // 对齐失败：保留上一次已确认对照，仅就地提示
      const message =
        action.result.status === 'failed'
          ? action.result.message
          : '对齐结果未形成有效对照';
      return {
        ...state,
        status: state.comparison !== null ? 'aligned' : 'ready',
        alignment: action.result,
        comparison: state.comparison,
        alignError: message,
        gen: action.gen
      };
    }
  }
}

/** 构造器仅用于测试：快速造出带已确认对照的会话状态 */
export function makeAlignedSession(params: {
  gen?: number;
  loaded: LoadedWav;
  comparison: ReworkComparison;
}): ReworkSessionState {
  return {
    status: 'aligned',
    loaded: params.loaded,
    loadError: null,
    comparison: params.comparison,
    alignment: params.comparison.alignment,
    alignError: null,
    gen: params.gen ?? 0
  };
}
