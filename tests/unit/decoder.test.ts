import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WavError } from '../../src/audio/types';
import { buildWavBytes } from '../fixtures/wav';

/** 极简 AudioBuffer 替身 */
class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly channels: Float32Array[];

  constructor(channels: Float32Array[], sampleRate: number) {
    this.channels = channels;
    this.numberOfChannels = channels.length;
    this.length = channels[0]?.length ?? 0;
    this.sampleRate = sampleRate;
  }

  getChannelData(index: number): Float32Array {
    return this.channels[index]!;
  }
}

class FakeFile {
  readonly name: string;
  private readonly bytes: ArrayBuffer;
  private readonly readError: Error | null;

  constructor(name: string, bytes: ArrayBuffer, readError: Error | null = null) {
    this.name = name;
    this.bytes = bytes;
    this.readError = readError;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.readError) throw this.readError;
    // 与真实 File.arrayBuffer 行为一致：返回可转移副本
    return this.bytes.slice(0);
  }
}

type DecodeBehavior =
  | { kind: 'buffer'; buffer: FakeAudioBuffer }
  | { kind: 'error'; message: string }
  | { kind: 'noChannels' }
  | { kind: 'zeroLength' };

let behavior: DecodeBehavior;
let unsupportedRate: number | null;

function installWebAudioStubs(): void {
  (globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = class {
    constructor(_channels: number, _length: number, sampleRate: number) {
      if (unsupportedRate !== null && sampleRate === unsupportedRate) {
        throw new Error('The provided sampleRate is not supported');
      }
    }

    async decodeAudioData(): Promise<FakeAudioBuffer> {
      if (behavior.kind === 'error') throw new Error(behavior.message);
      if (behavior.kind === 'noChannels')
        return {
          numberOfChannels: 0,
          length: 0,
          sampleRate: 8000,
          getChannelData: () => new Float32Array(0)
        } as unknown as FakeAudioBuffer;
      if (behavior.kind === 'zeroLength')
        return new FakeAudioBuffer([new Float32Array(0)], 8000);
      return behavior.buffer;
    }
  };
  (globalThis as unknown as { URL: { createObjectURL: () => string } }).URL = {
    createObjectURL: () => 'blob:fake-object-url'
  };
}

beforeEach(() => {
  vi.resetModules();
  unsupportedRate = null;
  installWebAudioStubs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadAndScanWav 本地解码全链路', () => {
  it('合法双声道 WAV：仅左声道削波，只该声道有段', async () => {
    const SR = 8000;
    const left = new Float32Array(20);
    const right = new Float32Array(20);
    for (let i = 5; i <= 7; i++) left[i] = 1; // 连续 3 帧削波
    behavior = { kind: 'buffer', buffer: new FakeAudioBuffer([left, right], SR) };

    const interleaved: number[] = [];
    for (let i = 0; i < 20; i++) interleaved.push(left[i]!, right[i]!);
    const bytes = buildWavBytes({
      channels: 2,
      sampleRate: SR,
      frameCount: 20,
      pcm: interleaved
    });

    const { loadAndScanWav } = await import('../../src/audio/decoder');
    const { result, objectUrl } = await loadAndScanWav(
      new FakeFile('stereo.wav', bytes) as unknown as File
    );

    expect(objectUrl).toBe('blob:fake-object-url');
    expect(result.fileName).toBe('stereo.wav');
    expect(result.sampleRate).toBe(SR);
    expect(result.hasClip).toBe(true);
    expect(result.channels).toHaveLength(2);
    expect(result.channels[0]!.segments).toHaveLength(1);
    expect(result.channels[1]!.segments).toHaveLength(0);
    expect(result.firstClip?.channel).toBe(0);
    expect(result.firstClip?.segment.startFrame).toBe(5);
    expect(result.firstClip?.segment.endFrame).toBe(7);
    // 3 帧 @8000Hz = 0.375ms → 四舍五入 0ms；起始 5/8000=0.625ms → 1ms
    expect(result.firstClip?.segment.startMs).toBe(1);
    expect(result.firstClip?.segment.durationMs).toBe(0);
    expect(result.totalClipMs).toBe(0);
  });

  it('解码器抛错 → DECODE_FAILED，不生成结果', async () => {
    behavior = { kind: 'error', message: 'EncodingError: bogus chunk' };
    const bytes = buildWavBytes({ frameCount: 8 });
    const { loadAndScanWav } = await import('../../src/audio/decoder');
    await expect(
      loadAndScanWav(new FakeFile('x.wav', bytes) as unknown as File)
    ).rejects.toMatchObject({ code: 'DECODE_FAILED' });
  });

  it('解码结果无声道 → NO_TRACK', async () => {
    behavior = { kind: 'noChannels' };
    const bytes = buildWavBytes({ frameCount: 8 });
    const { loadAndScanWav } = await import('../../src/audio/decoder');
    await expect(
      loadAndScanWav(new FakeFile('x.wav', bytes) as unknown as File)
    ).rejects.toMatchObject({ code: 'NO_TRACK' });
  });

  it('解码结果长度为 0 → NO_TRACK', async () => {
    behavior = { kind: 'zeroLength' };
    const bytes = buildWavBytes({ frameCount: 8 });
    const { loadAndScanWav } = await import('../../src/audio/decoder');
    await expect(
      loadAndScanWav(new FakeFile('x.wav', bytes) as unknown as File)
    ).rejects.toMatchObject({ code: 'NO_TRACK' });
  });

  it('非 WAV 字节 → NOT_WAV，且不调用解码器', async () => {
    const bytes = new TextEncoder().encode('this is definitely not a wav file').buffer;
    const { loadAndScanWav } = await import('../../src/audio/decoder');
    await expect(
      loadAndScanWav(new FakeFile('note.txt', bytes) as unknown as File)
    ).rejects.toMatchObject({ code: 'NOT_WAV' });
  });

  it('本地文件读取失败 → CORRUPT', async () => {
    const bytes = buildWavBytes({ frameCount: 4 });
    const file = new FakeFile(
      'x.wav',
      bytes,
      new Error('EACCES: permission denied')
    );
    const { loadAndScanWav } = await import('../../src/audio/decoder');
    await expect(
      loadAndScanWav(file as unknown as File)
    ).rejects.toMatchObject({ code: 'CORRUPT' });
  });

  it('浏览器不支持文件原生采样率时 → DECODE_FAILED', async () => {
    unsupportedRate = 8000;
    const bytes = buildWavBytes({ frameCount: 8 });
    const { loadAndScanWav } = await import('../../src/audio/decoder');
    await expect(
      loadAndScanWav(new FakeFile('x.wav', bytes) as unknown as File)
    ).rejects.toMatchObject({ code: 'DECODE_FAILED' });
  });

  it('WavError 形态：极小非 WAV 字节抛出 NOT_WAV', async () => {
    const bytes = new ArrayBuffer(3);
    const { loadAndScanWav } = await import('../../src/audio/decoder');
    try {
      await loadAndScanWav(new FakeFile('x.wav', bytes) as unknown as File);
      throw new Error('应当抛错');
    } catch (e) {
      // resetModules 后类身份不同，按 WavError 的 name/code 形态断言
      expect((e as WavError).name).toBe('WavError');
      expect((e as WavError).code).toBe('NOT_WAV');
    }
  });
});
