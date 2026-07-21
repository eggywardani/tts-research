import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { isS3Enabled, uploadFile, presignUrl, S3_PREFIX } from './s3.js';

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

// Generate speech. Forwards the multipart form straight through and streams the
// wav back. Keeping it a thin proxy is the whole point — the interesting bits
// live in the Python engine.
app.post('/api/speak', async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'expected multipart/form-data' }, 400);
  }

  try {
    const res = await fetch(`${TTS_URL}/speak`, { method: 'POST', body: form });

    if (!res.ok) {
      const body = await res.text();
      return c.json({ error: 'TTS generation failed', status: res.status, detail: body }, res.status as 400);
    }

    const meta = {
      sampleRate: res.headers.get('x-sample-rate') ?? '',
      engine: res.headers.get('x-engine') ?? '',
      chunks: res.headers.get('x-chunks') ?? '',
      rvc: res.headers.get('x-rvc') ?? '',
    };

    // When S3 is configured, archive the wav and hand back a presigned URL
    // instead of the bytes. Otherwise stream the audio straight through so the
    // playground still works with no AWS account (best-effort archival).
    if (isS3Enabled()) {
      const audio = Buffer.from(await res.arrayBuffer());
      const key = `${S3_PREFIX.outputs}${crypto.randomUUID()}.wav`;
      try {
        await uploadFile(key, audio);
        const url = await presignUrl(key);
        return c.json({ url, key, ...meta });
      } catch (err) {
        // Don't lose a successful generation to an S3 hiccup — fall back to bytes.
        console.error('[api] S3 upload failed, returning audio inline:', err);
        return new Response(audio, {
          status: 200,
          headers: {
            'content-type': res.headers.get('content-type') ?? 'audio/wav',
            'x-sample-rate': meta.sampleRate,
            'x-engine': meta.engine,
            'x-chunks': meta.chunks,
            'x-rvc': meta.rvc,
          },
        });
      }
    }

    return new Response(res.body, {
      status: 200,
      headers: {
        'content-type': res.headers.get('content-type') ?? 'audio/wav',
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
// so chunks can play as they're produced.
app.post('/api/speak-stream', async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'expected multipart/form-data' }, 400);
  }

  try {
    const res = await fetch(`${TTS_URL}/speak-stream`, { method: 'POST', body: form });
    if (!res.ok && !res.body) {
      const body = await res.text();
      return c.json({ error: 'TTS stream failed', status: res.status, detail: body }, res.status as 400);
    }
    return new Response(res.body, {
      status: res.status,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  } catch (err) {
    return c.json({ error: `TTS service unreachable at ${TTS_URL}`, detail: String(err) }, 502);
  }
});

console.log(`[api] listening on http://localhost:${PORT}  (TTS_URL=${TTS_URL})`);

export default { port: PORT, fetch: app.fetch };
