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
}

export interface SpeakResult {
  audioUrl: string;
  s3Key?: string;
  sampleRate: string;
  engine: string;
  rvc: boolean;
}

export async function fetchEngines() {
  const res = await fetch('/api/engines');
  if (!res.ok) throw new Error(`engines: ${res.status}`);
  return res.json();
}

export async function fetchHealth() {
  const res = await fetch('/health');
  if (!res.ok) throw new Error(`health: ${res.status}`);
  return res.json();
}

export async function speak(input: SpeakInput): Promise<SpeakResult> {
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

  if (input.mode === 'clone') {
    form.set('ref_text', input.refText);
    if (input.speakerWav) form.set('speaker_wav', input.speakerWav);
  } else {
    form.set('instruct', input.instruct);
  }

  const res = await fetch('/api/speak', { method: 'POST', body: form });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      detail = j.detail ?? j.error ?? detail;
    } catch {
      /* keep default */
    }
    throw new Error(detail);
  }

  // When the API archives to S3 it replies with JSON { url, key, ... } and the
  // audio lives in the bucket; otherwise it streams the wav bytes back directly.
  if (res.headers.get('content-type')?.includes('application/json')) {
    const j = await res.json();
    return {
      audioUrl: j.url,
      s3Key: j.key,
      sampleRate: j.sampleRate ?? '',
      engine: j.engine ?? input.engine,
      rvc: j.rvc === '1',
    };
  }

  const blob = await res.blob();
  return {
    audioUrl: URL.createObjectURL(blob),
    sampleRate: res.headers.get('x-sample-rate') ?? '',
    engine: res.headers.get('x-engine') ?? input.engine,
    rvc: res.headers.get('x-rvc') === '1',
  };
}

// ── streaming ────────────────────────────────────────────────────────────────
export type StreamEvent =
  | { type: 'start'; total: number; engine: string }
  | { type: 'chunk'; index: number; total: number; text: string; sample_rate: number; audio: string }
  | { type: 'chunk_error'; index: number; detail: string }
  | { type: 'done'; total: number }
  | { type: 'error'; detail: string };

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
  if (input.mode === 'clone') {
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

export async function speakStream(input: SpeakInput, onEvent: (e: StreamEvent) => void): Promise<void> {
  const res = await fetch('/api/speak-stream', { method: 'POST', body: buildForm(input) });
  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      detail = j.detail ?? j.error ?? detail;
    } catch {
      /* keep default */
    }
    throw new Error(detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as StreamEvent);
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}
