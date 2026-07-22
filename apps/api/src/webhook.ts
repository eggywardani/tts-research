// Webhook delivery for job status updates.
//
// Best-effort and fire-and-forget: the worker calls sendWebhook() and never
// awaits it, so a slow/unreachable receiver can't stall generation. Deliveries
// are SERIALIZED per job (a promise chain keyed by job id) so events arrive in
// order, and each POST is retried a few times with backoff. No signature —
// receivers should treat the payload as advisory and re-verify via GET /api/jobs.

export type WebhookEvent = 'queued' | 'processing' | 'progress' | 'completed' | 'failed' | 'cancelled';

export interface WebhookPayload {
  event: WebhookEvent;
  job_id: string;
  status: string;
  [key: string]: unknown;
}

const RETRY_DELAYS_MS = [1000, 5000, 15000]; // 3 retries after the first attempt
const TIMEOUT_MS = 30000;

// Per-job delivery chain — keeps events ordered without blocking the worker.
const chains = new Map<string, Promise<void>>();

/** Queue a webhook POST for a job. Ordered per job; never throws. */
export function sendWebhook(url: string, payload: WebhookPayload): void {
  const prev = chains.get(payload.job_id) ?? Promise.resolve();
  const next = prev.then(() => deliver(url, payload)).catch(() => {});
  chains.set(payload.job_id, next);
  // Drop the chain once a terminal event has been delivered, to avoid leaking.
  if (payload.event === 'completed' || payload.event === 'failed' || payload.event === 'cancelled') {
    void next.finally(() => {
      if (chains.get(payload.job_id) === next) chains.delete(payload.job_id);
    });
  }
}

async function deliver(url: string, payload: WebhookPayload): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return;
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        console.error(
          `[webhook] gave up on ${url} for job ${payload.job_id} (${payload.event}):`,
          err instanceof Error ? err.message : err,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}
