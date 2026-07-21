// Audio history — list / play / delete generated audio. Mounted at /api.
//
// Records are written by the generation routes in server.ts; here we expose them
// with presigned playback URLs and deletion (row + S3 object). Trimmed port of
// audio-processor-llm/apps/api/src/history.ts (list + delete only, no filters).
import { Hono } from 'hono';
import { isS3Enabled, deleteFile, deletePrefix, presignUrl, S3_PREFIX } from './s3.js';
import * as db from './db.js';

export const history = new Hono();

async function withUrl(r: db.HistoryRecord) {
  let url: string | null = null;
  if (isS3Enabled() && r.file_path) {
    try {
      url = await presignUrl(r.file_path);
    } catch {
      url = null;
    }
  }
  return { ...r, url };
}

// GET /api/history?limit=
history.get('/history', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const rows = await db.getHistory(limit);
  return c.json(await Promise.all(rows.map(withUrl)));
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
