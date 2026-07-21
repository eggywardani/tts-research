// Voice Library — CRUD for saved speaker samples. Mounted at /api/speakers.
//
// Management-first port of audio-processor-llm/apps/api/src/speakers.ts: upload
// a reference clip, store the bytes in S3 + metadata in Postgres, list/edit/
// delete, and expose a presigned URL for playback. No ffmpeg / Whisper / SNR
// analysis (those need Python endpoints this app's TTS service doesn't have).
import { Hono } from 'hono';
import { isS3Enabled, uploadFile, deleteFile, presignUrl, S3_PREFIX } from './s3.js';
import * as db from './db.js';
import type { EngineConfig, VoicePreset } from './db.js';

export const speakers = new Hono();

// Attach a presigned playback URL (when S3 is on) without mutating the row.
async function withAudioUrl(s: db.Speaker) {
  let audio_url: string | null = null;
  if (isS3Enabled() && s.file_path) {
    try {
      audio_url = await presignUrl(s.file_path);
    } catch {
      audio_url = null;
    }
  }
  return { ...s, audio_url };
}

const EXT_BY_TYPE: Record<string, string> = {
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/flac': '.flac',
  'audio/ogg': '.ogg',
};

function pickExt(file: File): string {
  const dot = file.name.lastIndexOf('.');
  if (dot > 0) return file.name.slice(dot).toLowerCase();
  return EXT_BY_TYPE[file.type] ?? '.wav';
}

// POST /api/speakers — multipart: name, language, ref_text?, voice_preset?, audio
speakers.post('/', async (c) => {
  if (!isS3Enabled()) {
    return c.json({ error: 'S3 is not configured; speaker storage is unavailable' }, 503);
  }
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'expected multipart/form-data' }, 400);
  }

  const name = String(form.get('name') ?? '').trim();
  const language = String(form.get('language') ?? 'en').trim() || 'en';
  const refText = String(form.get('ref_text') ?? '').trim();
  const audio = form.get('audio');

  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!(audio instanceof File) || audio.size === 0) {
    return c.json({ error: 'audio file is required' }, 400);
  }

  let preset: VoicePreset = {};
  const presetRaw = form.get('voice_preset');
  if (typeof presetRaw === 'string' && presetRaw.trim()) {
    try {
      preset = JSON.parse(presetRaw);
    } catch {
      return c.json({ error: 'voice_preset must be valid JSON' }, 400);
    }
  }

  const id = crypto.randomUUID();
  const key = `${S3_PREFIX.speakers}${id}${pickExt(audio)}`;
  try {
    await uploadFile(key, Buffer.from(await audio.arrayBuffer()), audio.type || 'audio/wav');
  } catch (err) {
    return c.json({ error: 'failed to store audio', detail: String(err) }, 502);
  }

  const engines: Record<string, EngineConfig> = { omnivoice: { preset, ref_text: refText } };
  const speaker = await db.addSpeaker({
    id,
    name,
    language,
    file_path: key,
    original_filename: audio.name || `${id}.wav`,
    default_engine: 'omnivoice',
    engines,
    voice_preset: preset,
  });

  return c.json(await withAudioUrl(speaker), 201);
});

// GET /api/speakers — list all
speakers.get('/', async (c) => {
  const all = await db.getSpeakers();
  return c.json(await Promise.all(all.map(withAudioUrl)));
});

// GET /api/speakers/:id
speakers.get('/:id', async (c) => {
  const s = await db.getSpeaker(c.req.param('id'));
  if (!s) return c.json({ error: 'not found' }, 404);
  return c.json(await withAudioUrl(s));
});

// PATCH /api/speakers/:id — update editable fields
speakers.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'expected JSON body' }, 400);
  }

  const updates: Record<string, unknown> = {};
  for (const field of ['name', 'language', 'voice_preset', 'engines', 'default_engine', 'api_enabled'] as const) {
    if (body[field] !== undefined) updates[field] = body[field];
  }

  const updated = await db.updateSpeaker(id, updates);
  if (!updated) return c.json({ error: 'not found' }, 404);
  return c.json(await withAudioUrl(updated));
});

// DELETE /api/speakers/:id — remove row + S3 object (history rows auto-null via FK)
speakers.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const s = await db.getSpeaker(id);
  if (!s) return c.json({ error: 'not found' }, 404);

  if (isS3Enabled() && s.file_path) {
    try {
      await deleteFile(s.file_path);
    } catch (err) {
      console.error(`[speakers] failed to delete S3 object ${s.file_path}:`, err);
    }
  }
  await db.deleteSpeaker(id);
  return c.json({ ok: true });
});
