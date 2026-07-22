// Thin client for the Bun+Hono backend. Same-origin; hooks.server.ts proxies to :9001.

export interface SpeakInput {
  text: string;
  engine: string;
  mode: 'clone' | 'design';
  refText: string;
  instruct: string;
  temperature: number;
  topP: number;
  cfgScale: number;
  seed: number;
  useRvc: boolean;
  rvcModel: string;
  rvcPitch: number;
  speakerWav: File | null;
  speakerId?: string | null; // reuse a saved voice for cloning
}

export interface VoicePreset {
  temperature?: number;
  top_p?: number;
  cfg_scale?: number;
  seed?: number;
  use_rvc?: boolean;
  rvc_model?: string;
  rvc_pitch?: number;
}

export interface Speaker {
  id: string;
  name: string;
  language: string;
  original_filename: string;
  duration_seconds: number | null;
  default_engine: string;
  engines: Record<string, { preset?: VoicePreset; ref_text?: string }>;
  voice_preset: VoicePreset;
  audio_url: string | null;
  created_at: string;
}

export interface HistoryParams {
  temperature?: number;
  top_p?: number;
  cfg_scale?: number;
  seed?: number;
  use_rvc?: boolean;
  rvc_model?: string;
  rvc_pitch?: number;
  ref_text?: string;
  instruct?: string;
  mode?: 'clone' | 'design';
}

export interface HistoryChunk {
  index: number;
  text: string;
  status: 'completed' | 'failed' | 'silent';
  duration_seconds?: number | null;
}

export interface HistoryItem {
  id: string;
  speaker_id: string | null;
  speaker_name: string | null;
  text: string;
  engine: string;
  params: HistoryParams;
  sample_rate: string;
  rvc: boolean;
  duration_seconds: number | null;
  chunks: HistoryChunk[];
  has_audio: boolean;
  url: string | null; // null in the list; populated by fetchHistoryItem on demand
  created_at: string;
}

async function fail(res: Response): Promise<never> {
  let detail = `HTTP ${res.status}`;
  try {
    const j = await res.json();
    detail = j.detail ?? j.error ?? detail;
  } catch {
    /* keep default */
  }
  throw new Error(detail);
}

export async function fetchEngines() {
  const res = await fetch('/api/engines');
  if (!res.ok) throw new Error(`engines: ${res.status}`);
  return res.json();
}

function buildForm(input: SpeakInput): FormData {
  const form = new FormData();
  form.set('text', input.text);
  form.set('engine', input.engine);
  form.set('temperature', String(input.temperature));
  form.set('top_p', String(input.topP));
  form.set('cfg_scale', String(input.cfgScale));
  form.set('seed', String(input.seed));
  form.set('use_rvc', String(input.useRvc));
  form.set('rvc_model', input.rvcModel);
  form.set('rvc_pitch', String(input.rvcPitch));

  if (input.speakerId) {
    // Saved speaker → the API attaches the stored clip + ref_text server-side.
    form.set('speaker_id', input.speakerId);
    form.set('ref_text', input.refText);
  } else if (input.mode === 'clone') {
    form.set('ref_text', input.refText);
    if (input.speakerWav) form.set('speaker_wav', input.speakerWav);
  } else {
    form.set('instruct', input.instruct);
  }
  return form;
}

/** Decode a base64 wav into an object URL the browser can play. */
export function b64ToAudioUrl(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

// ── jobs (async queue) ────────────────────────────────────────────────────────

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  status: JobStatus;
  position: number;
  total_chunks: number;
  completed_chunks: number;
  history_id: string | null;
  url: string | null;
  error: string | null;
  created_at: string;
  text?: string;
  engine?: string;
}

// Events streamed from GET /api/jobs/:id/stream.
export type JobEvent =
  | { type: 'snapshot'; status: JobStatus; position: number; total_chunks: number; completed_chunks: number; url: string | null }
  | { type: 'processing'; id: string }
  | { type: 'start'; total: number; engine: string }
  | { type: 'chunk'; index: number; total: number; text: string; audio: string }
  | { type: 'completed'; id: string; history_id: string; url: string | null }
  | { type: 'error'; detail: string }
  | { type: 'cancelled' };

/** Enqueue a generation. Returns the created job (status 'queued'). */
export async function createJob(input: SpeakInput): Promise<Job> {
  const res = await fetch('/api/jobs', { method: 'POST', body: buildForm(input) });
  if (!res.ok) await fail(res);
  return res.json();
}

export async function fetchJobs(limit = 50): Promise<Job[]> {
  const res = await fetch(`/api/jobs?limit=${limit}`);
  if (!res.ok) await fail(res);
  return res.json();
}

export async function getJob(id: string): Promise<Job> {
  const res = await fetch(`/api/jobs/${id}`);
  if (!res.ok) await fail(res);
  return res.json();
}

export async function cancelJob(id: string): Promise<void> {
  const res = await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' });
  if (!res.ok) await fail(res);
}

/**
 * Poll a job until it reaches a terminal state — the resilient fallback for when
 * the live SSE stream drops (common behind Cloudflare Tunnel / proxies). Tolerates
 * transient fetch failures; only gives up after several consecutive errors.
 */
export async function pollJob(id: string, onUpdate: (j: Job) => void, intervalMs = 2000): Promise<Job> {
  let consecutiveErrors = 0;
  for (;;) {
    try {
      const j = await getJob(id);
      consecutiveErrors = 0;
      onUpdate(j);
      if (j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled') return j;
    } catch (e) {
      if (++consecutiveErrors >= 5) throw e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Subscribe to a job's live progress over SSE until it reaches a terminal state. */
export async function streamJob(id: string, onEvent: (e: JobEvent) => void): Promise<void> {
  const res = await fetch(`/api/jobs/${id}/stream`);
  if (!res.ok || !res.body) await fail(res);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as JobEvent);
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}

// ── speakers ─────────────────────────────────────────────────────────────────

export async function fetchSpeakers(): Promise<Speaker[]> {
  const res = await fetch('/api/speakers');
  if (!res.ok) await fail(res);
  return res.json();
}

export async function createSpeaker(data: {
  name: string;
  language: string;
  refText?: string;
  audio: File;
  preset?: VoicePreset;
}): Promise<Speaker> {
  const form = new FormData();
  form.set('name', data.name);
  form.set('language', data.language);
  if (data.refText) form.set('ref_text', data.refText);
  if (data.preset) form.set('voice_preset', JSON.stringify(data.preset));
  form.set('audio', data.audio);
  const res = await fetch('/api/speakers', { method: 'POST', body: form });
  if (!res.ok) await fail(res);
  return res.json();
}

export async function updateSpeaker(id: string, updates: Partial<Pick<Speaker, 'name' | 'language' | 'voice_preset' | 'engines' | 'default_engine'>>): Promise<Speaker> {
  const res = await fetch(`/api/speakers/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) await fail(res);
  return res.json();
}

export async function deleteSpeaker(id: string): Promise<void> {
  const res = await fetch(`/api/speakers/${id}`, { method: 'DELETE' });
  if (!res.ok) await fail(res);
}

// ── history ──────────────────────────────────────────────────────────────────

export async function fetchHistory(limit = 50): Promise<HistoryItem[]> {
  const res = await fetch(`/api/history?limit=${limit}`);
  if (!res.ok) await fail(res);
  return res.json();
}

/** Fetch a single record WITH its presigned audio URL (signed on demand). */
export async function fetchHistoryItem(id: string): Promise<HistoryItem> {
  const res = await fetch(`/api/history/${id}`);
  if (!res.ok) await fail(res);
  return res.json();
}

export async function deleteHistory(id: string): Promise<void> {
  const res = await fetch(`/api/history/${id}`, { method: 'DELETE' });
  if (!res.ok) await fail(res);
}

export async function clearHistory(): Promise<void> {
  const res = await fetch('/api/history', { method: 'DELETE' });
  if (!res.ok) await fail(res);
}

// ── API tokens (per-client) ───────────────────────────────────────────────────

export interface ApiKey {
  id: string;
  name: string;
  token: string;
  disabled: boolean;
  request_count: number;
  last_used_at: string | null;
  created_at: string;
}

export async function fetchApiKeys(): Promise<ApiKey[]> {
  const res = await fetch('/api/keys');
  if (!res.ok) await fail(res);
  return res.json();
}

export async function createApiKey(name: string): Promise<ApiKey> {
  const res = await fetch('/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) await fail(res);
  return res.json();
}

export async function toggleApiKey(id: string, disabled: boolean): Promise<void> {
  const res = await fetch(`/api/keys/${id}/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ disabled }),
  });
  if (!res.ok) await fail(res);
}

export async function deleteApiKey(id: string): Promise<void> {
  const res = await fetch(`/api/keys/${id}`, { method: 'DELETE' });
  if (!res.ok) await fail(res);
}
