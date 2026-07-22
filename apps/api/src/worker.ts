// Worker pool. Spawns TTS_CONCURRENCY async loops; each claims a queued job and
// runs it. Because only N loops ever hold a job at once, GPU concurrency is
// bounded to N without any extra locking.
import { presignUrl, isS3Enabled } from './s3.js';
import {
  claimNext,
  updateProgress,
  completeJob,
  failJob,
  isCancelled,
  emit,
  wait,
  type Job,
} from './jobs.js';
import { runGeneration, CancelledError } from './generate.js';
import { sendWebhook } from './webhook.js';

const CONCURRENCY = Math.max(1, Number(process.env.TTS_CONCURRENCY ?? 1) || 1);
const IDLE_POLL_MS = 1000; // fallback; wake() nudges us sooner on new work

let started = false;

async function runJob(job: Job): Promise<void> {
  // When the caller supplied a webhook_url, mirror lifecycle events to it. Fire-
  // and-forget + ordered per job (see webhook.ts), so it never blocks the worker.
  const hook = job.request.webhook_url;
  const notify = (event: 'processing' | 'progress' | 'completed' | 'failed' | 'cancelled', extra: Record<string, unknown> = {}) => {
    if (hook) sendWebhook(hook, { event, job_id: job.id, status: event === 'progress' ? 'processing' : event, ...extra });
  };

  emit(job.id, 'processing', { id: job.id });
  notify('processing');
  try {
    const res = await runGeneration(job.id, job.request, {
      onStart: async (total, engine) => {
        await updateProgress(job.id, 0, total);
        emit(job.id, 'start', { total, engine });
      },
      onChunk: async (index, total, text, audio) => {
        await updateProgress(job.id, index + 1, total);
        emit(job.id, 'chunk', { index, total, text, audio });
        notify('progress', { completed_chunks: index + 1, total_chunks: total });
      },
      isCancelled: () => isCancelled(job.id),
    });

    await completeJob(job.id, { history_id: res.history_id, file_path: res.file_path });
    let url: string | null = null;
    if (res.file_path && isS3Enabled()) {
      try {
        url = await presignUrl(res.file_path);
      } catch {
        url = null;
      }
    }
    emit(job.id, 'completed', { id: job.id, history_id: res.history_id, url });
    notify('completed', { history_id: res.history_id, url });
  } catch (err) {
    if (err instanceof CancelledError) {
      emit(job.id, 'cancelled', {}); // status already set to cancelled
      notify('cancelled');
      return;
    }
    const detail = err instanceof Error ? err.message : String(err);
    await failJob(job.id, detail);
    emit(job.id, 'error', { detail });
    notify('failed', { error: detail });
  }
}

async function loop(): Promise<void> {
  for (;;) {
    let job: Job | null = null;
    try {
      job = await claimNext();
    } catch (err) {
      console.error('[worker] claim failed:', err);
    }
    if (!job) {
      await wait(IDLE_POLL_MS);
      continue;
    }
    await runJob(job);
  }
}

export function startWorkers(n = CONCURRENCY): void {
  if (started) return;
  started = true;
  for (let i = 0; i < n; i++) void loop();
  console.log(`[api] started ${n} worker(s) (TTS_CONCURRENCY=${n})`);
}
