-- Async generation queue. Requests become jobs; a worker pool claims them
-- (FOR UPDATE SKIP LOCKED), bounded to TTS_CONCURRENCY, so the GPU isn't
-- overwhelmed and callers can poll / stream status.

CREATE TABLE IF NOT EXISTS jobs (
  id               uuid PRIMARY KEY,
  status           text NOT NULL DEFAULT 'queued', -- queued|processing|completed|failed|cancelled
  priority         int  NOT NULL DEFAULT 1,        -- 0 high, 1 medium, 2 low
  request          jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_chunks     int  NOT NULL DEFAULT 0,
  completed_chunks int  NOT NULL DEFAULT 0,
  history_id       uuid REFERENCES history(id) ON DELETE SET NULL,
  file_path        text,
  error            text,
  attempts         int  NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  completed_at     timestamptz
);

CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs (status, priority, created_at);
CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs (created_at DESC);
