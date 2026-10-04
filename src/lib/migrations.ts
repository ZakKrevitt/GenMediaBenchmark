// Schema, applied in order on startup. Append new entries; never edit an applied one.
export const MIGRATIONS: [string, string][] = [
  [
    '001_benchmarks',
    `
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  action text NOT NULL,
  entity_id uuid,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- An image every model starts from, which turns a benchmark into image-to-video.
CREATE TABLE start_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  image_key text NOT NULL,
  content_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One prompt rendered on several models. Several prompts launched together share a suite.
CREATE TABLE benchmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  prompt text NOT NULL CHECK (length(prompt) BETWEEN 3 AND 3500),
  settings jsonb NOT NULL,
  winner_shot_id uuid,
  suite_id uuid,
  suite_name text CHECK (length(suite_name) <= 80),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX benchmarks_recent ON benchmarks (created_at DESC);
CREATE INDEX benchmarks_suite ON benchmarks (suite_id) WHERE suite_id IS NOT NULL;

-- One model's render of one benchmark prompt, recorded before the provider is called.
CREATE TABLE renders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  benchmark_id uuid NOT NULL REFERENCES benchmarks(id),
  direction jsonb NOT NULL,
  prompt text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('fal','higgsfield')),
  endpoint text NOT NULL,
  model text NOT NULL,
  aspect_ratio text NOT NULL,
  resolution text NOT NULL,
  duration_seconds int NOT NULL CHECK (duration_seconds BETWEEN 1 AND 30),
  estimated_cents int NOT NULL CHECK (estimated_cents > 0),
  state text NOT NULL CHECK (state IN ('SUBMITTING','RUNNING','DOWNLOADING','COMPLETE','FAILED','UNKNOWN')),
  request_id text UNIQUE,
  status_url text,
  response_url text,
  video_key text,
  poster_key text,
  seed bigint,
  error text,
  -- What the benchmark asked this model for after snapping to the model's own options.
  request_settings jsonb,
  rating smallint CHECK (rating BETWEEN 1 AND 5),
  note text CHECK (length(note) <= 600),
  -- ffprobe of the delivered file: width, height, seconds, fps, audio, bytes.
  output jsonb,
  -- Objective checks (motion, cuts, freezes, black frames, silence, loudness) and a filmstrip.
  analysis jsonb,
  strip_key text,
  -- Optional AI judge; its cost is reserved per render and counts toward the daily limit.
  judge_state text CHECK (judge_state IN ('QUEUED','RUNNING','DONE','FAILED')),
  judge jsonb,
  judge_cents int NOT NULL DEFAULT 0 CHECK (judge_cents >= 0),
  judge_started_at timestamptz,
  -- fal's own request record and billing event, read after the render finishes.
  queue_seconds numeric,
  run_seconds numeric,
  billed_cents numeric CHECK (billed_cents >= 0),
  reconciled_at timestamptz,
  reconcile_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  -- When the poller first saw generation under way (splits queue time from generation time).
  started_at timestamptz,
  -- When the provider reported the render finished, before our download.
  finished_at timestamptz,
  completed_at timestamptz,
  polled_at timestamptz
);
CREATE INDEX renders_benchmark ON renders (benchmark_id);
CREATE INDEX renders_open ON renders (created_at) WHERE state IN ('RUNNING','DOWNLOADING');
CREATE INDEX renders_unanalysed ON renders (completed_at) WHERE state = 'COMPLETE' AND analysis IS NULL;
CREATE INDEX renders_judge_queue ON renders (created_at) WHERE judge_state IN ('QUEUED','RUNNING');

-- Blind head-to-head votes between two renders of the same benchmark, turned into Elo.
CREATE TABLE benchmark_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  benchmark_id uuid NOT NULL REFERENCES benchmarks(id),
  left_shot_id uuid NOT NULL REFERENCES renders(id),
  right_shot_id uuid NOT NULL REFERENCES renders(id),
  outcome text NOT NULL CHECK (outcome IN ('left','right','tie','both_bad')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (left_shot_id <> right_shot_id)
);
CREATE INDEX benchmark_votes_benchmark ON benchmark_votes (benchmark_id);

-- When the app first saw each model, so new releases can be flagged.
CREATE TABLE benchmark_models_seen (
  provider text NOT NULL CHECK (provider IN ('fal','higgsfield')),
  endpoint text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, endpoint)
);
`,
  ],
];
