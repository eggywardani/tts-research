// Minimal WAV utilities — just enough to concatenate the per-chunk WAV files
// that /speak-stream emits into a single archivable file.
//
// The TTS service streams each chunk as a self-contained little-endian PCM WAV.
// We parse the `fmt ` + `data` subchunks, concatenate the raw PCM payloads, and
// wrap them in one fresh header. All chunks are assumed to share format
// (sample rate / channels / bit depth) — they come from the same engine run.

interface WavParts {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  data: Buffer;
}

// Walk the RIFF chunks to find `fmt ` + `data` (robust to extra chunks like LIST).
function parseWav(buf: Buffer): WavParts | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let offset = 12;
  let fmt: Omit<WavParts, 'data'> | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    // Chunks are word-aligned: an odd size is padded with one byte.
    offset = body + size + (size % 2);
  }
  if (!fmt || !data) return null;
  return { ...fmt, data };
}

function buildWav(parts: Omit<WavParts, 'data'>, pcm: Buffer): Buffer {
  const { channels, sampleRate, bitsPerSample } = parts;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(parts.audioFormat || 1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Concatenate WAV buffers into one. `fallbackSampleRate` is used only if a
// chunk somehow lacks a parseable header. Returns null if nothing was decodable.
export function mergeWavs(buffers: Buffer[], fallbackSampleRate = 24000): Buffer | null {
  const pcms: Buffer[] = [];
  let fmt: Omit<WavParts, 'data'> | null = null;
  for (const buf of buffers) {
    const parsed = parseWav(buf);
    if (!parsed) continue;
    if (!fmt) fmt = { audioFormat: parsed.audioFormat, channels: parsed.channels, sampleRate: parsed.sampleRate, bitsPerSample: parsed.bitsPerSample };
    pcms.push(parsed.data);
  }
  if (!fmt || pcms.length === 0) return null;
  if (!fmt.sampleRate) fmt.sampleRate = fallbackSampleRate;
  return buildWav(fmt, Buffer.concat(pcms));
}

// Rough duration in seconds from a WAV buffer (best-effort, for history metadata).
export function wavDuration(buf: Buffer): number | null {
  const parsed = parseWav(buf);
  if (!parsed || !parsed.sampleRate || !parsed.channels || !parsed.bitsPerSample) return null;
  const bytesPerSample = (parsed.channels * parsed.bitsPerSample) / 8;
  if (bytesPerSample === 0) return null;
  return parsed.data.length / bytesPerSample / parsed.sampleRate;
}
