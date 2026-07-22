// Per-client API token management — CRUD for the api_keys table. Mounted at
// /api/keys and reachable ONLY with the master API_TOKEN (i.e. the dashboard via
// its server-side proxy). Client tokens are rejected here by the auth gate in
// server.ts, so a client can never mint or revoke tokens.
import { Hono } from 'hono';
import * as db from './db.js';

export const keys = new Hono();

// GET /api/keys — list all tokens (newest first), including the plaintext value.
keys.get('/', async (c) => {
  return c.json(await db.listApiKeys());
});

// POST /api/keys — { name } → create + return the new token (full value visible).
keys.post('/', async (c) => {
  let name = '';
  try {
    const body = await c.req.json();
    name = String(body?.name ?? '').trim();
  } catch {
    /* fall through to the empty-name error */
  }
  if (!name) return c.json({ error: 'name is required' }, 400);
  const key = await db.createApiKey(name);
  return c.json(key, 201);
});

// POST /api/keys/:id/toggle — { disabled } → enable/disable without deleting.
keys.post('/:id/toggle', async (c) => {
  let disabled = true;
  try {
    const body = await c.req.json();
    disabled = Boolean(body?.disabled);
  } catch {
    /* default to disabling */
  }
  const ok = await db.setApiKeyDisabled(c.req.param('id'), disabled);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true, disabled });
});

// DELETE /api/keys/:id — revoke a token permanently.
keys.delete('/:id', async (c) => {
  const ok = await db.deleteApiKey(c.req.param('id'));
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});
