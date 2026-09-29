/**
 * 本地 WAV 读取与解码：
 * - input 元素拿到的 File 始终留在本机，通过 arrayBuffer() 读入内存；
 * - 先 parseWavHeader 做结构校验并取得文件原生采样率，
 *   再以该采样率构造 OfflineAudioContext 解码，避免输出被重采样；
 * - 全程不发起任何网络请求。
 */

import { WavError } from './types';
import { parseWavHeader } from './wav-parser';
import { buildScanResult } from './scanner';
import type { ScanResult } from './types';

export interface LoadedWav {
  result: ScanResult;
  /** 原始文件的本地对象 URL，供 <audio> 试听（从不离开本机） */
  objectUrl: string;
}

export async function loadAndScanWav(file: File): Promise<LoadedWav> {
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new WavError('CORRUPT', `无法读取本地文件“${file.name}”，文件可能已损坏或被截断`);
  }

  // 头结构校验：NOT_WAV / CORRUPT / NO_TRACK 在此抛出；同时取得原生采样率
  const header = parseWavHeader(bytes);

  let decoder: OfflineAudioContext;
  try {
    // 以文件原生采样率构造解码器：解码输出即为原速 PCM，帧/时间换算保持一致
    decoder = new OfflineAudioContext(1, 16, header.sampleRate);
  } catch {
    throw new WavError(
      'DECODE_FAILED',
      `当前浏览器不支持以 ${header.sampleRate} Hz 构造解码上下文，扫描未执行`
    );
  }

  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await decoder.decodeAudioData(bytes.slice(0));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new WavError('DECODE_FAILED', `Web Audio 解码失败：${detail}，扫描未执行`);
  }

  if (!audioBuffer || audioBuffer.numberOfChannels < 1) {
    throw new WavError('NO_TRACK', '解码结果不含任何声道，文件没有可读取的音轨');
  }
  if (audioBuffer.length === 0) {
    throw new WavError('NO_TRACK', '解码结果长度为 0，文件没有可读取的音轨');
  }

  const channelData: Float32Array[] = [];
  for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
    channelData.push(audioBuffer.getChannelData(i));
  }

  // 以解码结果实际采样率为准（正常情况下与头部一致）
  const result = buildScanResult(file.name, channelData, audioBuffer.sampleRate);
  return { result, objectUrl: URL.createObjectURL(file) };
}
