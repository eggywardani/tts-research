import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { isS3Enabled, presignUrl } from './s3.js';
import { runMigrations } from './migrate.js';
import { speakers } from './speakers.js';
import { history } from './history.js';
import {
  createJob,
  listJobs,
  getJob,
  queuePosition,
  cancelJob,
  subscribe,
  wake,
  recoverStaleJobs,
  startJobCleanup,
  isTerminal,
  type Job,
  type JobRequest,
} from './jobs.js';
import { startWorkers } from './worker.js';

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

// ── Job request parsing ──────────────────────────────────────────────────────

function num(v: unknown): number | undefined {
  return v == null || v === '' ? undefined : Number(v);
}

function toJobRequest(src: Record<string, unknown>): JobRequest {
  const instruct = String(src.instruct ?? '').trim();
  const speakerId = String(src.speaker_id ?? '').trim() || null;
  return {
    text: String(src.text ?? ''),
    engine: String(src.engine ?? 'omnivoice') || 'omnivoice',
    speaker_id: speakerId,
    mode: speakerId ? 'clone' : instruct ? 'design' : 'clone',
    instruct: instruct || undefined,
    ref_text: String(src.ref_text ?? '') || undefined,
    temperature: num(src.temperature),
    top_p: num(src.top_p),
    cfg_scale: num(src.cfg_scale),
    seed: num(src.seed),
    use_rvc: String(src.use_rvc ?? '') === 'true' || src.use_rvc === true,
    rvc_model: String(src.rvc_model ?? '') || undefined,
    rvc_pitch: num(src.rvc_pitch),
  };
}

// Accept either multipart/form-data (studio) or JSON (API consumers).
async function parseRequest(c: any): Promise<JobRequest | null> {
  const ct = c.req.header('content-type') ?? '';
  try {
    if (ct.includes('application/json')) {
      return toJobRequest(await c.req.json());
    }
    const form = await c.req.formData();
    const obj: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) obj[k] = v;
    return toJobRequest(obj);
  } catch {
    return null;
  }
}

function validate(req: JobRequest): string | null {
  if (!req.text.trim()) return 'text is required';
  if (!req.speaker_id && !req.instruct) return 'provide speaker_id (cloning) or instruct (voice design)';
  return null;
}

async function jobView(job: Job) {
  let url: string | null = null;
  if (job.file_path && isS3Enabled()) {
    try {
      url = await presignUrl(job.file_path);
    } catch {
      url = null;
    }
  }
  return {
    id: job.id,
    status: job.status,
    position: await queuePosition(job),
    total_chunks: job.total_chunks,
    completed_chunks: job.completed_chunks,
    history_id: job.history_id,
    url,
    error: job.error,
    created_at: job.created_at,
    text: job.request?.text ?? '',
    engine: job.request?.engine ?? 'omnivoice',
  };
}

// ── Job endpoints ────────────────────────────────────────────────────────────

// Enqueue a generation. Returns immediately with a job id; the worker pool runs
// it when a GPU slot frees. Poll GET /api/jobs/:id or stream .../stream.
app.post('/api/jobs', async (c) => {
  const req = await parseRequest(c);
  if (!req) return c.json({ error: 'expected multipart/form-data or JSON' }, 400);
  const err = validate(req);
  if (err) return c.json({ error: err }, 400);

  const job = await createJob(req);
  wake(); // nudge an idle worker
  return c.json(await jobView(job), 202);
});

app.get('/api/jobs', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const jobs = await listJobs(limit);
  return c.json(await Promise.all(jobs.map(jobView)));
});

app.get('/api/jobs/:id', async (c) => {
  const job = await getJob(c.req.param('id'));
  if (!job) return c.json({ error: 'not found' }, 404);
  return c.json(await jobView(job));
});

app.post('/api/jobs/:id/cancel', async (c) => {
  const ok = await cancelJob(c.req.param('id'));
  if (!ok) return c.json({ error: 'not cancellable (already finished or missing)' }, 409);
  return c.json({ ok: true });
});

// Live SSE progress. Emits the current snapshot, then queued/processing/start/
// chunk/progress/completed/error/cancelled events until the job is terminal.
app.get('/api/jobs/:id/stream', async (c) => {
  const id = c.req.param('id');
  const job = await getJob(id);
  if (!job) return c.json({ error: 'not found' }, 404);

  const enc = new TextEncoder();
  const snapshot = await jobView(job);
  let unsub: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const write = (type: string, data: unknown) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type, ...(data as object) })}\n\n`));
        } catch {
          /* stream closed */
        }
      };

      write('snapshot', snapshot);

      // Already finished before we connected — replay terminal + close.
      if (isTerminal(job.status)) {
        write(job.status, { id, url: snapshot.url, history_id: job.history_id, detail: job.error });
        controller.close();
        return;
      }

      unsub = subscribe(id, (event, data) => {
        write(event, data);
        if (event === 'completed' || event === 'error' || event === 'cancelled') {
          unsub?.();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      });
    },
    cancel() {
      unsub?.();
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

// Synchronous convenience: enqueue, wait for the job to finish, return the
// result. Shares the same queue/concurrency as the async path — handy for simple
// API consumers who want one blocking call. Pass async=1 to get 202 + job id.
app.post('/api/speak', async (c) => {
  const req = await parseRequest(c);
  if (!req) return c.json({ error: 'expected multipart/form-data or JSON' }, 400);
  const err = validate(req);
  if (err) return c.json({ error: err }, 400);

  const job = await createJob(req);
  wake();

  if (c.req.query('async') === '1') {
    return c.json(await jobView(job), 202);
  }

  const finished = await awaitJob(job.id);
  if (finished.status === 'failed') {
    return c.json({ error: 'generation failed', detail: finished.error }, 502);
  }
  if (finished.status === 'cancelled') {
    return c.json({ error: 'cancelled' }, 409);
  }
  return c.json(await jobView(finished));
});

// Resolve once a job reaches a terminal state (via the event bus, with an
// initial check in case it finished before we subscribed).
function awaitJob(id: string): Promise<Job> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const check = async () => {
      const j = await getJob(id);
      if (j && isTerminal(j.status) && !settled) {
        settled = true;
        unsub();
        resolve(j);
      }
    };
    const unsub = subscribe(id, (event) => {
      if (event === 'completed' || event === 'error' || event === 'cancelled') check().catch(reject);
    });
    check().catch(reject);
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────

try {
  await runMigrations();
  const recovered = await recoverStaleJobs();
  if (recovered) console.log(`[api] requeued ${recovered} stale job(s)`);
  startWorkers();
  startJobCleanup(); // prune finished jobs older than 1h, every 5 min
} catch (err) {
  console.error('[api] boot failed — is DATABASE_URL reachable?', err);
}

console.log(`[api] listening on http://localhost:${PORT}  (TTS_URL=${TTS_URL})`);

export default { port: PORT, fetch: app.fetch };
