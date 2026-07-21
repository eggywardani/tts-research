// Client-side audio analysis + trimming (Web Audio API). Lets the Voice Library
// show a quality score + waveform and trim a clip before upload — no server-side
// analysis needed. Mirrors the pre-upload UX of audio-processor-llm.

export interface AudioAnalysis {
  duration: number; // seconds
  sampleRate: number;
  snrDb: number; // estimated signal-to-noise ratio
  noiseLabel: 'Low' | 'Medium' | 'High';
  score: number; // 0-100
  optimization: 'Optimal' | 'Suboptimal';
  message: string;
}

let ctx: AudioContext | null = null;
function audioCtx(): AudioContext {
  if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  return ctx;
}

/** Decode an uploaded audio file into an AudioBuffer. */
export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const buf = await file.arrayBuffer();
  // decodeAudioData detaches the buffer, so pass a copy.
  return audioCtx().decodeAudioData(buf.slice(0));
}

/** Downmix an AudioBuffer to a single mono Float32Array. */
function toMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const len = buffer.length;
  const out = new Float32Array(len);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  for (let i = 0; i < len; i++) out[i] /= buffer.numberOfChannels;
  return out;
}

/** Downsample to `bars` peak magnitudes (0..1) for a waveform display. */
export function computePeaks(buffer: AudioBuffer, bars = 240): number[] {
  const data = toMono(buffer);
  const block = Math.max(1, Math.floor(data.length / bars));
  const peaks: number[] = [];
  let max = 0.0001;
  for (let b = 0; b < bars; b++) {
    let peak = 0;
    const start = b * block;
    for (let i = 0; i < block && start + i < data.length; i++) {
      const v = Math.abs(data[start + i]);
      if (v > peak) peak = v;
    }
    peaks.push(peak);
    if (peak > max) max = peak;
  }
  // Normalize to 0..1 so quiet clips still render a visible waveform.
  return peaks.map((p) => p / max);
}

/** Estimate quality: duration, SNR (noise floor vs signal), and a 0-100 score. */
export function analyzeAudio(buffer: AudioBuffer): AudioAnalysis {
  const data = toMono(buffer);
  const sr = buffer.sampleRate;
  const duration = buffer.duration;

  // Per-frame RMS → noise floor (low percentile) vs signal (high percentile).
  const frame = Math.max(1, Math.floor(sr * 0.02)); // 20ms frames
  const rms: number[] = [];
  for (let i = 0; i + frame <= data.length; i += frame) {
    let sum = 0;
    for (let j = 0; j < frame; j++) {
      const v = data[i + j];
      sum += v * v;
    }
    rms.push(Math.sqrt(sum / frame));
  }
  rms.sort((a, b) => a - b);
  const pct = (p: number) => rms[Math.min(rms.length - 1, Math.max(0, Math.floor(p * (rms.length - 1))))] || 0;
  const noise = Math.max(pct(0.1), 1e-6);
  const signal = Math.max(pct(0.95), noise);
  const snrDb = Math.max(0, Math.min(90, 20 * Math.log10(signal / noise)));

  const noiseLabel: AudioAnalysis['noiseLabel'] = snrDb >= 40 ? 'Low' : snrDb >= 20 ? 'Medium' : 'High';

  // Score: mostly SNR-driven (clean speech clones best); duration flagged separately.
  const snrScore = Math.max(0, Math.min(1, (snrDb - 15) / 30)); // 15dB→0, 45dB→1
  const score = Math.round(100 * (0.25 + 0.75 * snrScore));

  const optimization: AudioAnalysis['optimization'] = duration >= 8 && duration <= 25 ? 'Optimal' : 'Suboptimal';

  let message: string;
  if (score >= 85) message = 'Kualitas audio sangat baik untuk kloning suara!';
  else if (score >= 60) message = 'Kualitas audio cukup baik. Bersihkan noise untuk hasil lebih baik.';
  else message = 'Noise cukup tinggi — pakai rekaman yang lebih bersih untuk hasil terbaik.';

  return { duration, sampleRate: sr, snrDb, noiseLabel, score, optimization, message };
}

/** Extract [startSec, endSec] as a mono 16-bit PCM WAV Blob. */
export function sliceToWav(buffer: AudioBuffer, startSec: number, endSec: number): Blob {
  const sr = buffer.sampleRate;
  const data = toMono(buffer);
  const startS = Math.max(0, Math.floor(startSec * sr));
  const endS = Math.min(data.length, Math.floor(endSec * sr));
  const len = Math.max(0, endS - startS);

  const bytes = 44 + len * 2;
  const ab = new ArrayBuffer(bytes);
  const view = new DataView(ab);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + len * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, len * 2, true);

  let off = 44;
  for (let i = startS; i < endS; i++) {
    let s = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([ab], { type: 'audio/wav' });
}
