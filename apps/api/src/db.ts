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

export interface HistoryFilters {
  limit?: number;
  speaker_id?: string | null;
  engine?: string | null;
  search?: string | null;
  from_date?: string | null; // YYYY-MM-DD (inclusive)
  to_date?: string | null; // YYYY-MM-DD (inclusive — whole day)
}

export async function getHistory(filters: HistoryFilters = {}): Promise<HistoryRecord[]> {
  const limit = Math.min(Math.max(Number(filters.limit ?? 50) || 50, 1), 500);

  // Build a parameterized WHERE from whichever filters are set.
  const conds: string[] = [];
  const params: any[] = [];
  const add = (frag: string, val: unknown) => {
    params.push(val);
    conds.push(frag.replace('?', `$${params.length}`));
  };
  if (filters.speaker_id) add('h.speaker_id = ?', filters.speaker_id);
  if (filters.engine) add('h.engine = ?', filters.engine);
  if (filters.search) add('h.text ILIKE ?', `%${filters.search}%`);
  if (filters.from_date) add('h.created_at >= ?::date', filters.from_date);
  if (filters.to_date) add('h.created_at < (?::date + 1)', filters.to_date); // include the whole end day

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  params.push(limit);
  const rows = (await sql.unsafe(
    `SELECT h.*, s.name AS speaker_name
       FROM history h
       LEFT JOIN speakers s ON s.id = h.speaker_id
       ${where}
       ORDER BY h.created_at DESC
       LIMIT $${params.length}`,
    params,
  )) as any[];
  return rows.map(normHistory);
}

// Distinct values for the history filter dropdowns.
export async function getHistoryFilters(): Promise<{ speakers: { id: string; name: string }[]; engines: string[] }> {
  const speakerRows = (await sql`
    SELECT DISTINCT h.speaker_id AS id, s.name AS name
    FROM history h JOIN speakers s ON s.id = h.speaker_id
    WHERE h.speaker_id IS NOT NULL
    ORDER BY s.name
  `) as any[];
  const engineRows = (await sql`
    SELECT DISTINCT engine FROM history WHERE engine <> '' ORDER BY engine
  `) as any[];
  return {
    speakers: speakerRows.map((r) => ({ id: r.id, name: r.name })),
    engines: engineRows.map((r) => r.engine),
  };
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

// ── API keys (per-client tokens) ─────────────────────────────────────────────

// A per-client access token. Stored plaintext so it can be re-viewed/copied from
// the dashboard (mirrors cf-agregator). `disabled` gates it without deleting.
export interface ApiKey {
  id: string;
  name: string;
  token: string;
  disabled: boolean;
  request_count: number;
  last_used_at: string | null;
  created_at: string;
}

function normApiKey(r: any): ApiKey {
  return {
    id: r.id,
    name: r.name,
    token: r.token,
    disabled: r.disabled,
    request_count: Number(r.request_count ?? 0), // BIGINT → number (avoids bigint JSON)
    last_used_at: r.last_used_at ?? null,
    created_at: r.created_at,
  };
}

// "tts_" + 48 hex chars (24 random bytes). Prefix makes tokens greppable/rotatable.
function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `tts_${hex}`;
}

export async function listApiKeys(): Promise<ApiKey[]> {
  const rows = (await sql`SELECT * FROM api_keys ORDER BY created_at DESC`) as any[];
  return rows.map(normApiKey);
}

export async function createApiKey(name: string): Promise<ApiKey> {
  const rows = (await sql`
    INSERT INTO api_keys (id, name, token)
    VALUES (${crypto.randomUUID()}, ${name}, ${generateToken()})
    RETURNING *
  `) as any[];
  return normApiKey(rows[0]);
}

export async function setApiKeyDisabled(id: string, disabled: boolean): Promise<boolean> {
  const rows = (await sql`
    UPDATE api_keys SET disabled = ${disabled} WHERE id = ${id} RETURNING id
  `) as any[];
  return rows.length > 0;
}

export async function deleteApiKey(id: string): Promise<boolean> {
  const rows = (await sql`DELETE FROM api_keys WHERE id = ${id} RETURNING id`) as any[];
  return rows.length > 0;
}

/**
 * Validate a presented client token. Returns the key if it exists and is enabled,
 * else null. On success it records usage (request_count + last_used_at) fire-and-
 * forget so auth stays fast.
 */
export async function validateApiKey(token: string): Promise<ApiKey | null> {
  const rows = (await sql`
    SELECT * FROM api_keys WHERE token = ${token} AND disabled = false
  `) as any[];
  const key = rows[0] ? normApiKey(rows[0]) : null;
  if (key) void recordApiKeyUsage(key.id);
  return key;
}

async function recordApiKeyUsage(id: string): Promise<void> {
  try {
    await sql`
      UPDATE api_keys
      SET request_count = request_count + 1, last_used_at = now()
      WHERE id = ${id}
    `;
  } catch {
    /* usage tracking is best-effort — never fail a request over it */
  }
}
