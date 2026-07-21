-- Speakers (saved voice samples) + generation history.

CREATE TABLE IF NOT EXISTS speakers (
  id                uuid PRIMARY KEY,
  name              text NOT NULL,
  language          text NOT NULL DEFAULT 'en',
  file_path         text NOT NULL,
  original_filename text NOT NULL DEFAULT '',
  duration_seconds  double precision,
  is_default        boolean NOT NULL DEFAULT false,
  api_enabled       boolean NOT NULL DEFAULT true,
  default_engine    text NOT NULL DEFAULT 'omnivoice',
  engines           jsonb NOT NULL DEFAULT '{}'::jsonb,
  voice_preset      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS history (
  id               uuid PRIMARY KEY,
  speaker_id       uuid REFERENCES speakers(id) ON DELETE SET NULL,
  text             text NOT NULL DEFAULT '',
  engine           text NOT NULL DEFAULT 'omnivoice',
  params           jsonb NOT NULL DEFAULT '{}'::jsonb,
  file_path        text,
  sample_rate      text NOT NULL DEFAULT '',
  rvc              boolean NOT NULL DEFAULT false,
  duration_seconds double precision,
  source           text NOT NULL DEFAULT 'dashboard',
  chunks           jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS history_created_at_idx ON history (created_at DESC);
