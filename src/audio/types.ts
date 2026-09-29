/** 核验台核心数据类型 */

export interface ClipSegment {
  /** 首帧索引（包含） */
  startFrame: number;
  /** 末帧索引（包含） */
  endFrame: number;
  /** 首帧时间（秒），首帧 / sampleRate */
  startSeconds: number;
  /** 末帧后一帧时间（秒），(endFrame + 1) / sampleRate */
  endSeconds: number;
  /** 段时长（秒），(endFrame - startFrame + 1) / sampleRate */
  durationSeconds: number;
  /** 起始时间，毫秒，四舍五入（0.5 向上取整） */
  startMs: number;
  /** 结束时间，毫秒，四舍五入（0.5 向上取整） */
  endMs: number;
  /** 段时长，毫秒，按精确时长四舍五入（0.5 向上取整） */
  durationMs: number;
}

export interface ChannelScan {
  /** 声道序号，0 起 */
  channel: number;
  segments: ClipSegment[];
  /** 该声道所有段时长累加（秒，精确值） */
  totalClipSeconds: number;
  /** 该声道总削波时长（毫秒，对精确合计四舍五入） */
  totalClipMs: number;
  frameCount: number;
  sampleRate: number;
}

export interface ScanResult {
  fileName: string;
  sampleRate: number;
  channels: ChannelScan[];
  /** 各声道区间时长累加（秒，精确值；同一时刻多声道削波分别计入） */
  totalClipSeconds: number;
  /** 总削波时长（毫秒，对精确合计四舍五入） */
  totalClipMs: number;
  /** 任一声道存在区间 */
  hasClip: boolean;
  /** 全声道首个削波段 */
  firstClip: { channel: number; segment: ClipSegment } | null;
  /** 每声道原始 PCM 数据引用（解码缓冲不复制） */
  channelData: Float32Array[];
  durationSeconds: number;
}

export type WavErrorCode =
  | 'NOT_WAV'
  | 'CORRUPT'
  | 'NO_TRACK'
  | 'DECODE_FAILED';

export class WavError extends Error {
  code: WavErrorCode;
  constructor(code: WavErrorCode, message: string) {
    super(message);
    this.name = 'WavError';
    this.code = code;
  }
}

export const ERROR_MESSAGES: Record<WavErrorCode, string> = {
  NOT_WAV: '文件不是有效的 WAV 音频',
  CORRUPT: 'WAV 文件已损坏或被截断',
  NO_TRACK: 'WAV 文件不含可读取的音轨',
  DECODE_FAILED: '音频解码失败，扫描未执行'
};
