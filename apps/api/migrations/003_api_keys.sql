-- Per-client API tokens for direct programmatic access to the TTS API.
-- Stored in plaintext so the token can be viewed / re-copied from the dashboard
-- (mirrors cf-agregator's api_keys). Management endpoints (/api/keys) are
-- admin-only; a valid, enabled token here grants access to every other /api/*
-- route, so each client can carry its own distinct token.
CREATE TABLE IF NOT EXISTS api_keys (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  token         text NOT NULL UNIQUE,
  disabled      boolean NOT NULL DEFAULT false,
  request_count bigint NOT NULL DEFAULT 0,
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_keys_token_idx ON api_keys (token);
