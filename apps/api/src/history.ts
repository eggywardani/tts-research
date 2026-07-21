// Audio history — list / play / delete generated audio. Mounted at /api.
//
// Records are written by the generation routes in server.ts; here we expose them
// with presigned playback URLs and deletion (row + S3 object). Trimmed port of
// audio-processor-llm/apps/api/src/history.ts (list + delete only, no filters).
import { Hono } from 'hono';
import { isS3Enabled, deleteFile, deletePrefix, presignUrl, S3_PREFIX } from './s3.js';
import * as db from './db.js';

export const history = new Hono();

// GET /api/history?limit= — list WITHOUT presigned URLs. We deliberately don't
// embed playback URLs here: rendering an <audio> per row would make the browser
// fetch each object from S3 on page load (bandwidth cost). Instead we expose
// `has_audio`, and the client fetches the presigned URL on demand via
// GET /api/history/:id when the user actually opens a result.
history.get('/history', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const rows = await db.getHistory(limit);
  return c.json(rows.map((r) => ({ ...r, url: null, has_audio: Boolean(isS3Enabled() && r.file_path) })));
});

// GET /api/history/:id — a single record WITH a presigned URL (signed on demand,
// only when the user opens its detail). Presigning is a local operation (no S3
// call); the actual S3 GET happens only if/when the browser plays the audio.
history.get('/history/:id', async (c) => {
  const rec = await db.getHistoryItem(c.req.param('id'));
  if (!rec) return c.json({ error: 'not found' }, 404);
  let url: string | null = null;
  if (isS3Enabled() && rec.file_path) {
    try {
      url = await presignUrl(rec.file_path);
    } catch {
      url = null;
    }
  }
  return c.json({ ...rec, url, has_audio: Boolean(isS3Enabled() && rec.file_path) });
});

// DELETE /api/history/:id — remove one record + its S3 object(s)
history.delete('/history/:id', async (c) => {
  const id = c.req.param('id');
  const removed = await db.deleteHistory(id);
  if (!removed) return c.json({ error: 'not found' }, 404);
  if (isS3Enabled() && removed.file_path) {
    try {
      await deleteFile(removed.file_path);
    } catch (err) {
      console.error(`[history] failed to delete S3 object ${removed.file_path}:`, err);
    }
  }
  return c.json({ ok: true });
});

// DELETE /api/history — clear all (best-effort S3 cleanup under outputs/)
history.delete('/history', async (c) => {
  const removed = await db.clearHistory();
  if (isS3Enabled()) {
    for (const r of removed) {
      if (r.file_path) {
        try {
          await deleteFile(r.file_path);
        } catch {
          /* best-effort */
        }
      }
    }
    // Sweep any orphaned chunk objects too.
    try {
      await deletePrefix(S3_PREFIX.outputs);
    } catch {
      /* best-effort */
    }
  }
  return c.json({ ok: true, deleted: removed.length });
});
