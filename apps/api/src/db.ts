// Postgres data layer for speakers + generation history.
//
// Uses Bun's built-in SQL client (no extra dependency). Modeled on
// audio-processor-llm/apps/api/src/db.ts, but backed by Postgres instead of a
// JSON file. Tables are created idempotently by migrate(), called on boot.
import { SQL } from 'bun';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tts:tts@localhost:5432/tts';

export const sql = new SQL(DATABASE_URL);

// ── Types ──────────────────────────────────────────────────────────────────

// A voice preset captures THIS app's real generation params so a saved speaker
// reproduces the same sound. All optional — callers override per request.
export interface VoicePreset {
  temperature?: number;
  top_p?: number;
  cfg_scale?: number;
  seed?: number;
  use_rvc?: boolean;
  rvc_model?: string;
  rvc_pitch?: number;
}

// Per-engine config. The schema is multi-engine-capable even though only
// `omnivoice` exists today: engines is a map keyed by engine name.
export interface EngineConfig {
  preset?: VoicePreset;
  ref_text?: string;
  audio_key?: string; // optional S3 key for an engine-specific reference clip
}

export interface Speaker {
  id: string;
  name: string;
  language: string;
  file_path: string; // S3 key, e.g. speakers/{id}.wav
  original_filename: string;
  duration_seconds: number | null;
  is_default: boolean;
  api_enabled: boolean;
  default_engine: string;
  engines: Record<string, EngineConfig>;
  voice_preset: VoicePreset;
  created_at: string;
  updated_at: string;
}

export interface HistoryChunk {
  index: number;
  text: string;
  status: 'completed' | 'failed' | 'silent';
  duration_seconds?: number | null;
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

export interface HistoryRecord {
  id: string;
  speaker_id: string | null;
  speaker_name?: string | null; // joined from speakers at query time
  text: string;
  engine: string;
  params: HistoryParams;
  file_path: string | null; // S3 key, null when S3 archival is off
  sample_rate: string;
  rvc: boolean;
  duration_seconds: number | null;
  source: string;
  chunks: HistoryChunk[];
  created_at: string;
}

// ── Row normalization ────────────────────────────────────────────────────────
// Bun's SQL driver parses jsonb to objects for INSERT ... RETURNING but hands
// back raw JSON strings for JOIN selects. Normalize defensively so callers
// always get parsed objects regardless of query shape.
function asJson<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

function normSpeaker(row: any): Speaker {
  return { ...row, engines: asJson(row.engines, {}), voice_preset: asJson(row.voice_preset, {}) };
}

function normHistory(row: any): HistoryRecord {
  return { ...row, params: asJson(row.params, {}), chunks: asJson(row.chunks, []) };
}

// Schema lives in ../migrations/*.sql, applied by runMigrations() in migrate.ts.

// ── Speakers ─────────────────────────────────────────────────────────────────

export async function getSpeakers(): Promise<Speaker[]> {
  // Defaults last, otherwise most-recent first — matches the reference ordering.
  const rows = (await sql`
    SELECT * FROM speakers
    ORDER BY is_default ASC, created_at DESC
  `) as any[];
  return rows.map(normSpeaker);
}

export async function getSpeaker(id: string): Promise<Speaker | null> {
  const rows = (await sql`SELECT * FROM speakers WHERE id = ${id}`) as any[];
  return rows[0] ? normSpeaker(rows[0]) : null;
}

export async function addSpeaker(s: {
  id: string;
  name: string;
  language: string;
  file_path: string;
  original_filename: string;
  duration_seconds?: number | null;
  default_engine?: string;
  engines?: Record<string, EngineConfig>;
  voice_preset?: VoicePreset;
}): Promise<Speaker> {
  const rows = (await sql`
    INSERT INTO speakers (id, name, language, file_path, original_filename,
                          duration_seconds, default_engine, engines, voice_preset)
    VALUES (${s.id}, ${s.name}, ${s.language}, ${s.file_path}, ${s.original_filename},
            ${s.duration_seconds ?? null}, ${s.default_engine ?? 'omnivoice'},
            ${JSON.stringify(s.engines ?? {})}::jsonb, ${JSON.stringify(s.voice_preset ?? {})}::jsonb)
    RETURNING *
  `) as any[];
  return normSpeaker(rows[0]);
}

export async function updateSpeaker(
  id: string,
  updates: Partial<Pick<Speaker, 'name' | 'language' | 'voice_preset' | 'engines' | 'default_engine' | 'api_enabled'>>,
): Promise<Speaker | null> {
  const current = await getSpeaker(id);
  if (!current) return null;
  const next = { ...current, ...updates };
  const rows = (await sql`
    UPDATE speakers SET
      name           = ${next.name},
      language       = ${next.language},
      voice_preset   = ${JSON.stringify(next.voice_preset)}::jsonb,
      engines        = ${JSON.stringify(next.engines)}::jsonb,
      default_engine = ${next.default_engine},
      api_enabled    = ${next.api_enabled},
      updated_at     = now()
    WHERE id = ${id}
    RETURNING *
  `) as any[];
  return rows[0] ? normSpeaker(rows[0]) : null;
}

export async function deleteSpeaker(id: string): Promise<void> {
  await sql`DELETE FROM speakers WHERE id = ${id}`;
}

// ── History ──────────────────────────────────────────────────────────────────

export async function getHistory(limit = 50): Promise<HistoryRecord[]> {
  const rows = (await sql`
    SELECT h.*, s.name AS speaker_name
    FROM history h
    LEFT JOIN speakers s ON s.id = h.speaker_id
    ORDER BY h.created_at DESC
    LIMIT ${limit}
  `) as any[];
  return rows.map(normHistory);
}

export async function getHistoryItem(id: string): Promise<HistoryRecord | null> {
  const rows = (await sql`
    SELECT h.*, s.name AS speaker_name
    FROM history h
    LEFT JOIN speakers s ON s.id = h.speaker_id
    WHERE h.id = ${id}
  `) as any[];
  return rows[0] ? normHistory(rows[0]) : null;
}

export async function addHistory(r: {
  id: string;
  speaker_id?: string | null;
  text: string;
  engine: string;
  params: HistoryParams;
  file_path?: string | null;
  sample_rate?: string;
  rvc?: boolean;
  duration_seconds?: number | null;
  source?: string;
  chunks?: HistoryChunk[];
}): Promise<HistoryRecord> {
  const rows = (await sql`
    INSERT INTO history (id, speaker_id, text, engine, params, file_path,
                         sample_rate, rvc, duration_seconds, source, chunks)
    VALUES (${r.id}, ${r.speaker_id ?? null}, ${r.text}, ${r.engine},
            ${JSON.stringify(r.params)}::jsonb, ${r.file_path ?? null},
            ${r.sample_rate ?? ''}, ${r.rvc ?? false}, ${r.duration_seconds ?? null},
            ${r.source ?? 'dashboard'}, ${JSON.stringify(r.chunks ?? [])}::jsonb)
    RETURNING *
  `) as any[];
  return normHistory(rows[0]);
}

export async function deleteHistory(id: string): Promise<HistoryRecord | null> {
  const rows = (await sql`DELETE FROM history WHERE id = ${id} RETURNING *`) as any[];
  return rows[0] ? normHistory(rows[0]) : null;
}

export async function clearHistory(): Promise<HistoryRecord[]> {
  const rows = (await sql`DELETE FROM history RETURNING *`) as any[];
  return rows.map(normHistory);
}
