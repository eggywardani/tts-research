import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { isS3Enabled, uploadFile, downloadFile, presignUrl, S3_PREFIX } from './s3.js';
import * as db from './db.js';
import { runMigrations } from './migrate.js';
import { speakers } from './speakers.js';
import { history } from './history.js';
import { mergeWavs, wavDuration } from './wav.js';

const TTS_URL = process.env.TTS_URL ?? 'http://localhost:9000';
const PORT = Number(process.env.PORT ?? 9001);

const API_TOKEN = process.env.API_TOKEN ?? '';

const app = new Hono();

app.use('/*', cors());

// Optional shared-secret gate. When API_TOKEN is set, every /api/* call must
// carry it in `x-api-token` — this stops someone hitting the backend directly
// and bypassing the dashboard password. The web app injects the header via its
// server-side proxy (hooks.server.ts), so the browser never sees the token.
// No token set = gate off.
app.use('/api/*', async (c, next) => {
  if (!API_TOKEN) return next();
  if (c.req.header('x-api-token') === API_TOKEN) return next();
  return c.json({ error: 'unauthorized' }, 401);
});

app.get('/health', async (c) => {
  let tts: unknown = { status: 'unreachable' };
  try {
    const res = await fetch(`${TTS_URL}/health`, { signal: AbortSignal.timeout(3000) });
    tts = await res.json();
  } catch (err) {
    tts = { status: 'unreachable', error: String(err) };
  }
  return c.json({ status: 'ok', tts_url: TTS_URL, tts });
});

// Engine metadata — proxied so the frontend only ever talks to this API.
app.get('/api/engines', async (c) => {
  try {
    const res = await fetch(`${TTS_URL}/engines`, { signal: AbortSignal.timeout(5000) });
    return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    return c.json({ error: `TTS service unreachable at ${TTS_URL}`, detail: String(err) }, 502);
  }
});

// Speaker library + history routers.
app.route('/api/speakers', speakers);
app.route('/api', history);

// ── Shared helpers ───────────────────────────────────────────────────────────

// Numeric form fields we care about for history metadata + preset fill.
function readParams(form: FormData): db.HistoryParams {
  const num = (k: string) => {
    const v = form.get(k);
    return v == null || v === '' ? undefined : Number(v);
  };
  return {
    temperature: num('temperature'),
    top_p: num('top_p'),
    cfg_scale: num('cfg_scale'),
    seed: num('seed'),
    use_rvc: String(form.get('use_rvc') ?? '') === 'true',
    rvc_model: String(form.get('rvc_model') ?? '') || undefined,
    rvc_pitch: num('rvc_pitch'),
    ref_text: String(form.get('ref_text') ?? '') || undefined,
    instruct: String(form.get('instruct') ?? '') || undefined,
    mode: (String(form.get('instruct') ?? '') ? 'design' : 'clone'),
  };
}

// If the request names a saved speaker, load it, attach its stored clip as
// `speaker_wav`, and fill ref_text from the speaker's engine config when the
// caller didn't provide one. Mutates `form` in place. Returns the speaker (or
// null when none / not found — the caller falls back to the raw request).
async function applySpeaker(form: FormData): Promise<db.Speaker | null> {
  const speakerId = String(form.get('speaker_id') ?? '').trim();
  if (!speakerId) return null;

  const speaker = await db.getSpeaker(speakerId);
  if (!speaker) return null;

  const engine = speaker.default_engine || 'omnivoice';
  const cfg = speaker.engines?.[engine] ?? {};

  // Fetch the reference clip from S3 and forward it as the cloning sample.
  if (speaker.file_path) {
    const bytes = await downloadFile(speaker.file_path);
    const blob = new Blob([bytes], { type: 'audio/wav' });
    form.set('speaker_wav', blob, speaker.original_filename || `${speaker.id}.wav`);
    form.set('instruct', ''); // a saved speaker is always clone-mode
  }

  // ref_text: prefer the caller's, else the speaker's stored transcript.
  if (!String(form.get('ref_text') ?? '').trim() && cfg.ref_text) {
    form.set('ref_text', cfg.ref_text);
  }
  return speaker;
}

// Generate speech. Forwards the multipart form to the TTS service, optionally
// swapping in a saved speaker's clip, archives the wav to S3 (when configured),
// records a history row, and replies with the presigned URL (or the bytes when
// S3 is off, so the playground still works locally).
app.post('/api/speak', async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'expected multipart/form-data' }, 400);
  }

  let speaker: db.Speaker | null = null;
  try {
    speaker = await applySpeaker(form);
  } catch (err) {
    return c.json({ error: 'failed to load saved speaker', detail: String(err) }, 502);
  }

  const params = readParams(form);
  const text = String(form.get('text') ?? '');
  const engine = String(form.get('engine') ?? 'omnivoice');
  // speaker_id is ours — don't forward it to the TTS service.
  form.delete('speaker_id');

  try {
    const res = await fetch(`${TTS_URL}/speak`, { method: 'POST', body: form });

    if (!res.ok) {
      const body = await res.text();
      return c.json({ error: 'TTS generation failed', status: res.status, detail: body }, res.status as 400);
    }

    const meta = {
      sampleRate: res.headers.get('x-sample-rate') ?? '',
      engine: res.headers.get('x-engine') ?? engine,
      chunks: res.headers.get('x-chunks') ?? '',
      rvc: res.headers.get('x-rvc') ?? '0',
    };

    const audio = Buffer.from(await res.arrayBuffer());
    const id = crypto.randomUUID();
    let key: string | null = null;
    let url: string | null = null;

    if (isS3Enabled()) {
      key = `${S3_PREFIX.outputs}${id}.wav`;
      try {
        await uploadFile(key, audio);
        url = await presignUrl(key);
      } catch (err) {
        console.error('[api] S3 upload failed, keeping audio inline:', err);
        key = null;
      }
    }

    // Record history regardless of S3 (file_path stays null when archival is off).
    try {
      await db.addHistory({
        id,
        speaker_id: speaker?.id ?? null,
        text,
        engine: meta.engine,
        params,
        file_path: key,
        sample_rate: meta.sampleRate,
        rvc: meta.rvc === '1',
        duration_seconds: wavDuration(audio),
        chunks: [],
      });
    } catch (err) {
      console.error('[api] failed to record history:', err);
    }

    if (url) {
      return c.json({ id, url, key, ...meta });
    }

    // No S3 — stream the bytes back like before (history still recorded).
    return new Response(audio, {
      status: 200,
      headers: {
        'content-type': res.headers.get('content-type') ?? 'audio/wav',
        'x-history-id': id,
        'x-sample-rate': meta.sampleRate,
        'x-engine': meta.engine,
        'x-chunks': meta.chunks,
        'x-rvc': meta.rvc,
      },
    });
  } catch (err) {
    return c.json({ error: `TTS service unreachable at ${TTS_URL}`, detail: String(err) }, 502);
  }
});

// Progressive generation. Streams the TTS service's SSE straight to the browser
// so chunks can play as they're produced, while also collecting each chunk to
// merge into one archived wav + a history row once generation completes.
app.post('/api/speak-stream', async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'expected multipart/form-data' }, 400);
  }

  let speaker: db.Speaker | null = null;
  try {
    speaker = await applySpeaker(form);
  } catch (err) {
    return c.json({ error: 'failed to load saved speaker', detail: String(err) }, 502);
  }

  const params = readParams(form);
  const text = String(form.get('text') ?? '');
  const engine = String(form.get('engine') ?? 'omnivoice');
  form.delete('speaker_id');

  let upstream: Response;
  try {
    upstream = await fetch(`${TTS_URL}/speak-stream`, { method: 'POST', body: form });
  } catch (err) {
    return c.json({ error: `TTS service unreachable at ${TTS_URL}`, detail: String(err) }, 502);
  }
  if ((!upstream.ok && !upstream.body) || !upstream.body) {
    const body = await upstream.text();
    return c.json({ error: 'TTS stream failed', status: upstream.status, detail: body }, upstream.status as 400);
  }

  const id = crypto.randomUUID();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const chunkAudio: Buffer[] = [];
  const chunkMeta: db.HistoryChunk[] = [];
  let sampleRate = '';
  let usedRvc = String(form.get('use_rvc') ?? '') === 'true';

  // Parse SSE `data:` events out of a growing buffer, collecting chunk audio.
  const handleEvent = (jsonText: string) => {
    let ev: any;
    try {
      ev = JSON.parse(jsonText);
    } catch {
      return;
    }
    if (ev.type === 'chunk' && typeof ev.audio === 'string') {
      chunkAudio.push(Buffer.from(ev.audio, 'base64'));
      chunkMeta.push({ index: ev.index, text: ev.text ?? '', status: 'completed' });
      if (ev.sample_rate) sampleRate = String(ev.sample_rate);
    } else if (ev.type === 'chunk_error') {
      chunkMeta.push({ index: ev.index, text: '', status: 'failed' });
    }
  };

  const reader = upstream.body.getReader();

  const stream = new ReadableStream({
    async pull(controller) {
      let buffered = '';
      // Drain the whole upstream stream, forwarding bytes verbatim and parsing
      // events as they complete (separated by a blank line).
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        controller.enqueue(value); // forward to the browser unchanged
        buffered += dec.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffered.indexOf('\n\n')) !== -1) {
          const block = buffered.slice(0, sep);
          buffered = buffered.slice(sep + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data:')) handleEvent(line.slice(5).trim());
          }
        }
      }

      // Generation finished — merge, archive, and record.
      let url: string | null = null;
      let key: string | null = null;
      const merged = chunkAudio.length ? mergeWavs(chunkAudio, Number(sampleRate) || 24000) : null;

      if (merged && isS3Enabled()) {
        key = `${S3_PREFIX.outputs}${id}.wav`;
        try {
          await uploadFile(key, merged);
          url = await presignUrl(key);
        } catch (err) {
          console.error('[api] stream S3 upload failed:', err);
          key = null;
        }
      }

      try {
        await db.addHistory({
          id,
          speaker_id: speaker?.id ?? null,
          text,
          engine,
          params,
          file_path: key,
          sample_rate: sampleRate,
          rvc: usedRvc,
          duration_seconds: merged ? wavDuration(merged) : null,
          chunks: chunkMeta,
        });
      } catch (err) {
        console.error('[api] failed to record stream history:', err);
      }

      // Tell the client where the archived result lives.
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'saved', id, url })}\n\n`));
      controller.close();
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
});

// Run migrations before accepting traffic; fail loudly if the DB is unreachable.
try {
  await runMigrations();
} catch (err) {
  console.error('[api] migration failed — is DATABASE_URL reachable?', err);
}

console.log(`[api] listening on http://localhost:${PORT}  (TTS_URL=${TTS_URL})`);

export default { port: PORT, fetch: app.fetch };
