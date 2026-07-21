// Generation core, shared by the worker. Turns a JobRequest into audio by
// streaming from the TTS service, then archives the merged wav to S3 and records
// a history row. Extracted from the old inline /api/speak-stream handler.
import { isS3Enabled, uploadFile, downloadFile, S3_PREFIX } from './s3.js';
import * as db from './db.js';
import { mergeWavs, wavDuration } from './wav.js';
import type { JobRequest } from './jobs.js';

const TTS_URL = process.env.TTS_URL ?? 'http://localhost:9000';

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export interface GenerateHooks {
  onStart?: (total: number, engine: string) => void | Promise<void>;
  onChunk?: (index: number, total: number, text: string, audioB64: string) => void | Promise<void>;
  isCancelled?: () => boolean | Promise<boolean>;
}

export interface GenerateResult {
  history_id: string;
  file_path: string | null;
  sample_rate: string;
  duration_seconds: number | null;
  total_chunks: number;
}

// Map a JobRequest into the params blob stored on the history row.
function historyParams(req: JobRequest): db.HistoryParams {
  return {
    temperature: req.temperature,
    top_p: req.top_p,
    cfg_scale: req.cfg_scale,
    seed: req.seed,
    use_rvc: req.use_rvc,
    rvc_model: req.rvc_model || undefined,
    rvc_pitch: req.rvc_pitch,
    ref_text: req.ref_text || undefined,
    instruct: req.instruct || undefined,
    mode: req.speaker_id ? 'clone' : req.instruct ? 'design' : 'clone',
  };
}

// Build the multipart form sent to the TTS service, resolving a saved speaker.
async function buildForm(req: JobRequest): Promise<{ form: FormData; speaker: db.Speaker | null }> {
  const form = new FormData();
  form.set('text', req.text);
  form.set('engine', req.engine || 'omnivoice');
  form.set('temperature', String(req.temperature ?? 0.7));
  form.set('top_p', String(req.top_p ?? 0.9));
  form.set('cfg_scale', String(req.cfg_scale ?? 2.0));
  form.set('seed', String(req.seed ?? -1));
  form.set('use_rvc', String(req.use_rvc ?? false));
  form.set('rvc_model', req.rvc_model ?? '');
  form.set('rvc_pitch', String(req.rvc_pitch ?? 0));

  let speaker: db.Speaker | null = null;
  if (req.speaker_id) {
    speaker = await db.getSpeaker(req.speaker_id);
    if (!speaker) throw new Error(`speaker ${req.speaker_id} not found`);
    const cfg = speaker.engines?.[speaker.default_engine || 'omnivoice'] ?? {};
    if (speaker.file_path) {
      const bytes = await downloadFile(speaker.file_path);
      form.set('speaker_wav', new Blob([bytes], { type: 'audio/wav' }), speaker.original_filename || `${speaker.id}.wav`);
    }
    form.set('ref_text', (req.ref_text || cfg.ref_text || '').trim());
    form.set('instruct', '');
  } else {
    form.set('instruct', req.instruct ?? '');
    form.set('ref_text', req.ref_text ?? '');
  }
  return { form, speaker };
}

export async function runGeneration(jobId: string, req: JobRequest, hooks: GenerateHooks = {}): Promise<GenerateResult> {
  const { form, speaker } = await buildForm(req);

  const upstream = await fetch(`${TTS_URL}/speak-stream`, { method: 'POST', body: form });
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    throw new Error(`TTS stream failed (${upstream.status}) ${detail}`.trim());
  }

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  const chunkAudio: Buffer[] = [];
  const chunkMeta: db.HistoryChunk[] = [];
  let sampleRate = '';
  let total = 0;
  let buffered = '';

  const abort = async () => {
    await reader.cancel().catch(() => {});
  };

  outer: for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += dec.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffered.indexOf('\n\n')) !== -1) {
      const block = buffered.slice(0, sep);
      buffered = buffered.slice(sep + 2);
      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let ev: any;
      try {
        ev = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }

      if (ev.type === 'start') {
        total = ev.total ?? 0;
        await hooks.onStart?.(total, ev.engine ?? req.engine);
      } else if (ev.type === 'chunk' && typeof ev.audio === 'string') {
        chunkAudio.push(Buffer.from(ev.audio, 'base64'));
        chunkMeta.push({ index: ev.index, text: ev.text ?? '', status: 'completed' });
        if (ev.sample_rate) sampleRate = String(ev.sample_rate);
        await hooks.onChunk?.(ev.index, ev.total ?? total, ev.text ?? '', ev.audio);
      } else if (ev.type === 'chunk_error') {
        chunkMeta.push({ index: ev.index, text: '', status: 'failed' });
      }

      if (await hooks.isCancelled?.()) {
        await abort();
        throw new CancelledError();
      }
    }
  }

  // Merge + archive + record history.
  const merged = chunkAudio.length ? mergeWavs(chunkAudio, Number(sampleRate) || 24000) : null;
  let filePath: string | null = null;
  if (merged && isS3Enabled()) {
    filePath = `${S3_PREFIX.outputs}${jobId}.wav`;
    await uploadFile(filePath, merged);
  }

  const record = await db.addHistory({
    id: jobId, // reuse the job id as the history id for easy cross-reference
    speaker_id: speaker?.id ?? null,
    text: req.text,
    engine: req.engine || 'omnivoice',
    params: historyParams(req),
    file_path: filePath,
    sample_rate: sampleRate,
    rvc: !!(req.use_rvc && req.rvc_model),
    duration_seconds: merged ? wavDuration(merged) : null,
    chunks: chunkMeta,
  });

  return {
    history_id: record.id,
    file_path: filePath,
    sample_rate: sampleRate,
    duration_seconds: record.duration_seconds,
    total_chunks: chunkMeta.length,
  };
}
