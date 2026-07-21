// Job queue data layer + in-process event bus.
//
// Jobs live in Postgres (durable, survives restart, claimable across workers via
// FOR UPDATE SKIP LOCKED). The event bus is in-process only — it powers live SSE
// for clients connected to this instance; polling GET /api/jobs/:id is the
// durable fallback.
import { sql } from './db.js';

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

// Everything the worker needs to run a generation (mirrors the studio form).
export interface JobRequest {
  text: string;
  engine: string;
  speaker_id?: string | null;
  mode?: 'clone' | 'design';
  instruct?: string;
  ref_text?: string;
  temperature?: number;
  top_p?: number;
  cfg_scale?: number;
  seed?: number;
  use_rvc?: boolean;
  rvc_model?: string;
  rvc_pitch?: number;
}

export interface Job {
  id: string;
  status: JobStatus;
  priority: number;
  request: JobRequest;
  total_chunks: number;
  completed_chunks: number;
  history_id: string | null;
  file_path: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const TERMINAL: JobStatus[] = ['completed', 'failed', 'cancelled'];
export const isTerminal = (s: JobStatus) => TERMINAL.includes(s);

// Bun's SQL returns jsonb as a string on some query shapes — normalize defensively.
function norm(row: any): Job {
  return { ...row, request: typeof row.request === 'string' ? JSON.parse(row.request) : (row.request ?? {}) };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function createJob(request: JobRequest, priority = 1): Promise<Job> {
  const id = crypto.randomUUID();
  const rows = (await sql`
    INSERT INTO jobs (id, status, priority, request)
    VALUES (${id}, 'queued', ${priority}, ${JSON.stringify(request)}::jsonb)
    RETURNING *
  `) as any[];
  return norm(rows[0]);
}

export async function getJob(id: string): Promise<Job | null> {
  const rows = (await sql`SELECT * FROM jobs WHERE id = ${id}`) as any[];
  return rows[0] ? norm(rows[0]) : null;
}

export async function listJobs(limit = 50): Promise<Job[]> {
  const rows = (await sql`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ${limit}`) as any[];
  return rows.map(norm);
}

// 1-based position among queued jobs (0 when not queued). Counts queued jobs
// strictly ahead (in-DB, to avoid timestamp precision loss on round-trip) + 1.
export async function queuePosition(job: Job): Promise<number> {
  if (job.status !== 'queued') return 0;
  const rows = (await sql`
    WITH j AS (SELECT priority, created_at FROM jobs WHERE id = ${job.id})
    SELECT count(*)::int + 1 AS n
    FROM jobs, j
    WHERE jobs.status = 'queued'
      AND (jobs.priority < j.priority OR (jobs.priority = j.priority AND jobs.created_at < j.created_at))
  `) as { n: number }[];
  return rows[0]?.n ?? 1;
}

// ── Worker claim / lifecycle ─────────────────────────────────────────────────

// Atomically grab the next queued job. SKIP LOCKED lets multiple workers claim
// distinct jobs without blocking each other.
export async function claimNext(): Promise<Job | null> {
  const rows = (await sql`
    UPDATE jobs SET status = 'processing', started_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued'
      ORDER BY priority, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `) as any[];
  return rows[0] ? norm(rows[0]) : null;
}

export async function updateProgress(id: string, completed: number, total?: number): Promise<void> {
  if (total != null) {
    await sql`UPDATE jobs SET completed_chunks = ${completed}, total_chunks = ${total} WHERE id = ${id}`;
  } else {
    await sql`UPDATE jobs SET completed_chunks = ${completed} WHERE id = ${id}`;
  }
}

export async function completeJob(id: string, r: { history_id: string | null; file_path: string | null }): Promise<void> {
  await sql`
    UPDATE jobs SET status = 'completed', history_id = ${r.history_id}, file_path = ${r.file_path}, completed_at = now()
    WHERE id = ${id}
  `;
}

export async function failJob(id: string, error: string): Promise<void> {
  await sql`UPDATE jobs SET status = 'failed', error = ${error}, completed_at = now() WHERE id = ${id}`;
}

// Cancel a queued or in-flight job. Returns true if it was actually cancellable.
export async function cancelJob(id: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE jobs SET status = 'cancelled', completed_at = now()
    WHERE id = ${id} AND status IN ('queued', 'processing')
    RETURNING id
  `) as { id: string }[];
  if (rows.length) emit(id, 'cancelled', {});
  return rows.length > 0;
}

export async function isCancelled(id: string): Promise<boolean> {
  const rows = (await sql`SELECT status FROM jobs WHERE id = ${id}`) as { status: JobStatus }[];
  return rows[0]?.status === 'cancelled';
}

// On boot, requeue jobs left 'processing' by a crashed worker.
export async function recoverStaleJobs(): Promise<number> {
  const rows = (await sql`
    UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'processing' RETURNING id
  `) as { id: string }[];
  return rows.length;
}

// Delete finished jobs (anything not queued/processing) older than the cutoff.
// Only the ephemeral queue row is removed — the History archive + S3 audio are
// separate and untouched (jobs.history_id references history ON DELETE SET NULL,
// not the other way round).
export async function cleanupOldJobs(olderThanSeconds = 3600): Promise<number> {
  const rows = (await sql`
    DELETE FROM jobs
    WHERE status NOT IN ('queued', 'processing')
      AND COALESCE(completed_at, created_at) < now() - (${olderThanSeconds} * interval '1 second')
    RETURNING id
  `) as { id: string }[];
  return rows.length;
}

// Periodically prune old finished jobs. Runs once at boot, then on an interval.
let cleanupStarted = false;
export function startJobCleanup(intervalMs = 5 * 60 * 1000, olderThanSeconds = 3600): void {
  if (cleanupStarted) return;
  cleanupStarted = true;
  const run = () =>
    cleanupOldJobs(olderThanSeconds)
      .then((n) => {
        if (n) console.log(`[api] pruned ${n} finished job(s) older than ${olderThanSeconds}s`);
      })
      .catch((err) => console.error('[api] job cleanup failed:', err));
  run();
  setInterval(run, intervalMs);
}

// ── In-process event bus (live SSE) ──────────────────────────────────────────

type Listener = (event: string, data: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

export function subscribe(id: string, listener: Listener): () => void {
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id)!.add(listener);
  return () => {
    const set = listeners.get(id);
    set?.delete(listener);
    if (set && set.size === 0) listeners.delete(id);
  };
}

export function emit(id: string, event: string, data: unknown): void {
  const set = listeners.get(id);
  if (!set) return;
  for (const l of set) l(event, data);
}

// Worker wake signal: workers await wait(); a new enqueue / free slot calls wake()
// so processing starts immediately instead of waiting for the poll timeout.
let waiters: Array<() => void> = [];
export function wake(): void {
  const w = waiters;
  waiters = [];
  for (const resolve of w) resolve();
}
export function wait(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      waiters = waiters.filter((r) => r !== onWake);
      resolve();
    }, timeoutMs);
    const onWake = () => {
      clearTimeout(t);
      resolve();
    };
    waiters.push(onWake);
  });
}
