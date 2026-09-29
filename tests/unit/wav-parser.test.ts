import { describe, expect, it } from 'vitest';
import { parseWavHeader } from '../../src/audio/wav-parser';
import { WavError, type WavErrorCode } from '../../src/audio/types';
import { buildWavBytes } from '../fixtures/wav';
import {
  buildDataBeyondRiffBytes,
  buildHalfFrameTailBytes,
  buildLegalExtensionBytes,
  buildOutOfRegionFmtBytes
} from '../fixtures/acceptance-wav';

function expectCode(fn: () => unknown, code: WavErrorCode): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WavError);
    expect((e as WavError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 WavError(${code})，但未抛错`);
}

describe('WAV 头解析', () => {
  it('合法 PCM WAV 解析成功', () => {
    const info = parseWavHeader(buildWavBytes({}));
    expect(info).toMatchObject({
      channels: 1,
      sampleRate: 8000,
      bitsPerSample: 16,
      frameCount: 4
    });
  });

  it('双声道 24bit 合法文件解析成功', () => {
    const info = parseWavHeader(
      buildWavBytes({ channels: 2, sampleRate: 44100, bitsPerSample: 24, frameCount: 10 })
    );
    expect(info.frameCount).toBe(10);
    expect(info.channels).toBe(2);
  });

  it('8bit/32bit 位深解析成功', () => {
    expect(parseWavHeader(buildWavBytes({ bitsPerSample: 8 })).bitsPerSample).toBe(8);
    expect(parseWavHeader(buildWavBytes({ bitsPerSample: 32 })).bitsPerSample).toBe(32);
  });

  it('奇数尺寸 LIST 区块的填充字节被正确跳过', () => {
    const info = parseWavHeader(
      buildWavBytes({
        extraChunks: [{ id: 'LIST', size: 5, odd: true }],
        frameCount: 2
      })
    );
    expect(info.frameCount).toBe(2);
  });

  it('IEEE float(formatTag=3) 与 extensible(0xfffe) 头解析成功', () => {
    expect(parseWavHeader(buildWavBytes({ formatTag: 3 })).formatTag).toBe(3);
    expect(parseWavHeader(buildWavBytes({ formatTag: 0xfffe })).formatTag).toBe(
      0xfffe
    );
  });

  it('ADPCM 等其它编码（如 formatTag=2）头结构仍可解析，交给解码器定夺', () => {
    // 非 PCM/float/extensible 时不校验 byteRate，结构合法即放行
    const info = parseWavHeader(
      buildWavBytes({ formatTag: 2, byteRateOverride: 999 })
    );
    expect(info.formatTag).toBe(2);
  });

  it('不是 RIFF/WAVE → NOT_WAV', () => {
    expectCode(() => parseWavHeader(buildWavBytes({ riffTag: 'RIFX' })), 'NOT_WAV');
    expectCode(() => parseWavHeader(buildWavBytes({ waveTag: 'AVI ' })), 'NOT_WAV');
  });

  it('字节过小 → NOT_WAV', () => {
    expectCode(() => parseWavHeader(new ArrayBuffer(4)), 'NOT_WAV');
  });

  it('RIFF 声明尺寸超出实际字节 → CORRUPT（截断）', () => {
    const buf = buildWavBytes({ frameCount: 100, truncate: 60 });
    expectCode(() => parseWavHeader(buf), 'CORRUPT');
  });

  it('区块超出文件末尾 → CORRUPT', () => {
    // 手工构造：data 声明 999 字节但文件立刻结束（RIFF 尺寸声明一致，绕过前置校验）
    const buf = new ArrayBuffer(44);
    const v = new DataView(buf);
    const enc = (s: string, off: number) => {
      for (let i = 0; i < 4; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    enc('RIFF', 0);
    v.setUint32(4, 36, true);
    enc('WAVE', 8);
    enc('fmt ', 12);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true);
    v.setUint32(28, 16000, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    enc('data', 36);
    v.setUint32(40, 999, true);
    expectCode(() => parseWavHeader(buf), 'CORRUPT');
  });

  it('非法位深 → CORRUPT', () => {
    expectCode(() => parseWavHeader(buildWavBytes({ bitsOverride: 12 })), 'CORRUPT');
  });

  it('非法声道数 → CORRUPT', () => {
    expectCode(() => parseWavHeader(buildWavBytes({ channelsOverride: 0 })), 'CORRUPT');
    expectCode(() => parseWavHeader(buildWavBytes({ channelsOverride: 65 })), 'CORRUPT');
  });

  it('非法采样率 → CORRUPT', () => {
    expectCode(
      () => parseWavHeader(buildWavBytes({ sampleRateOverride: 0 })),
      'CORRUPT'
    );
    expectCode(
      () => parseWavHeader(buildWavBytes({ sampleRateOverride: 1_000_000 })),
      'CORRUPT'
    );
  });

  it('块对齐与声道/位深不一致 → CORRUPT', () => {
    expectCode(() => parseWavHeader(buildWavBytes({ blockAlignOverride: 7 })), 'CORRUPT');
  });

  it('PCM/IEEE-float 字节率不一致 → CORRUPT', () => {
    expectCode(() => parseWavHeader(buildWavBytes({ byteRateOverride: 123 })), 'CORRUPT');
    expectCode(
      () => parseWavHeader(buildWavBytes({ formatTag: 3, byteRateOverride: 1 })),
      'CORRUPT'
    );
  });

  it('缺 fmt 区块 → CORRUPT', () => {
    expectCode(() => parseWavHeader(buildWavBytes({ fmtTag: 'xxxx' })), 'CORRUPT');
  });

  it('缺 data 区块 → NO_TRACK', () => {
    expectCode(() => parseWavHeader(buildWavBytes({ includeData: false })), 'NO_TRACK');
  });

  it('0 帧数据 → NO_TRACK', () => {
    expectCode(() => parseWavHeader(buildWavBytes({ dataBytesOverride: 0 })), 'NO_TRACK');
  });

  it('WavError 携带错误码', () => {
    try {
      parseWavHeader(new ArrayBuffer(2));
      throw new Error('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(WavError);
      expect((e as WavError).code).toBe('NOT_WAV');
    }
  });
});

describe('WAV RIFF 区域结构完整性（固定字节样本）', () => {
  it('区域外格式块：RIFF 已结束、文件尾再附 fmt 块 → CORRUPT', () => {
    const bytes = buildOutOfRegionFmtBytes();
    // 前置事实：物理文件 76 字节，声明 RIFF 区域仅到 52
    expect(bytes.length).toBe(76);
    expectCode(() => parseWavHeader(bytes.buffer), 'CORRUPT');
  });

  it('越界音频块：data 块体在物理文件内但越过 RIFF 末端 → CORRUPT', () => {
    const bytes = buildDataBeyondRiffBytes();
    // 前置事实：物理文件 60 字节，RIFF 末端 44，data 声明 16 字节体 [44,60)
    expect(bytes.length).toBe(60);
    expectCode(() => parseWavHeader(bytes.buffer), 'CORRUPT');
  });

  it('半帧尾部：data 字节数不能被帧大小整除 → CORRUPT，不截短帧数', () => {
    const bytes = buildHalfFrameTailBytes();
    // 立体声 16bit（帧 4 字节），data 10 字节 = 2.5 帧
    expect(bytes.length).toBe(54);
    expectCode(() => parseWavHeader(bytes.buffer), 'CORRUPT');
  });

  it('合法扩展块：区域内含奇数尺寸 LIST（带对齐填充）→ 解析成功且帧数准确', () => {
    const bytes = buildLegalExtensionBytes();
    const info = parseWavHeader(bytes.buffer);
    expect(info.channels).toBe(1);
    expect(info.sampleRate).toBe(8000);
    expect(info.frameCount).toBe(80);
    expect(info.dataBytes).toBe(160);
    // 区域末端与物理文件末端严格一致
    expect(bytes.length).toBe(8 + 36 + 14 + 160);
  });

  it('区域外普通字节（非区块）同样 → CORRUPT，不接受区域外尾随数据', () => {
    // 合法 4 帧 WAV（52 字节）后附 7 个零字节：凑不出完整块头也必须判损坏
    const base = buildWavBytes({ frameCount: 4 });
    const merged = new Uint8Array(base.byteLength + 7);
    merged.set(new Uint8Array(base), 0);
    expectCode(() => parseWavHeader(merged.buffer), 'CORRUPT');
  });

  it('区域外恰好 8 字节“data 块头”（无体）→ CORRUPT', () => {
    const base = buildWavBytes({ frameCount: 4 });
    const merged = new Uint8Array(base.byteLength + 8);
    merged.set(new Uint8Array(base), 0);
    const v = new DataView(merged.buffer);
    const off = base.byteLength;
    const enc = (s: string, o: number) => {
      for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i));
    };
    enc('data', off);
    v.setUint32(off + 4, 0, true);
    expectCode(() => parseWavHeader(merged.buffer), 'CORRUPT');
  });

  it('区域内未被区块覆盖的残留字节 → CORRUPT', () => {
    // 合法 4 帧文件（riffSize=44），声明尺寸多写 3 字节并补 3 个零字节：
    // 区块走到 52 后循环终止，但 riffEnd=55，出现 3 字节无法解析的残留
    const base = new Uint8Array(buildWavBytes({ frameCount: 4, riffSize: 47 }));
    const merged = new Uint8Array(base.byteLength + 3);
    merged.set(base, 0);
    expectCode(() => parseWavHeader(merged.buffer), 'CORRUPT');
  });

  it('末块为奇数尺寸且对齐填充越过 RIFF 末端 → CORRUPT', () => {
    // fmt 占 [12,36)，data 头占 [36,44)，3 字节奇数尺寸块体占 [44,47)；
    // 声明 riffSize=39（riffEnd=47）：块体恰好到区域末端，
    // 但奇数尺寸所需的对齐填充字节落在区域外第 47 位
    const riffSize = 39;
    const buf = new ArrayBuffer(8 + riffSize);
    const v = new DataView(buf);
    const enc = (s: string, o: number) => {
      for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i));
    };
    enc('RIFF', 0);
    v.setUint32(4, riffSize, true);
    enc('WAVE', 8);
    enc('fmt ', 12);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true);
    v.setUint32(28, 16000, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    enc('data', 36);
    v.setUint32(40, 3, true); // 奇数尺寸 → 需要一字节填充
    expectCode(() => parseWavHeader(buf), 'CORRUPT');
  });

  it('RIFF 声明尺寸小到放不下 WAVE 标识 → CORRUPT', () => {
    const buf = buildWavBytes({ frameCount: 1, riffSize: 2 });
    expectCode(() => parseWavHeader(buf), 'CORRUPT');
  });

  it('单声道尾部 1 个残缺字节（不足一帧）→ CORRUPT', () => {
    // 单声道 16bit 帧大小 2：data 声明 3 字节（1 帧 + 1 残字节）
    const riffSize = 36 + 3;
    const buf = new ArrayBuffer(8 + riffSize);
    const v = new DataView(buf);
    const enc = (s: string, o: number) => {
      for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i));
    };
    enc('RIFF', 0);
    v.setUint32(4, riffSize, true);
    enc('WAVE', 8);
    enc('fmt ', 12);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true);
    v.setUint32(28, 16000, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    enc('data', 36);
    v.setUint32(40, 3, true);
    expectCode(() => parseWavHeader(buf), 'CORRUPT');
  });

  it('帧大小整除时不再向下取整：完整帧数按 dataBytes/blockAlign 精确给出', () => {
    const info = parseWavHeader(buildWavBytes({ channels: 2, frameCount: 7 }));
    expect(info.frameCount).toBe(7);
  });
});
