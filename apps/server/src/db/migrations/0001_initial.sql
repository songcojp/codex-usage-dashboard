CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS "devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "os" text NOT NULL,
  "hostname_hash" text NOT NULL,
  "device_token_hash" text NOT NULL UNIQUE,
  "last_seen_at" timestamptz,
  "disabled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "tools" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug" text NOT NULL UNIQUE,
  "display_name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "display_name" text NOT NULL,
  "repo_hash" text NOT NULL DEFAULT '',
  "remote_hash" text NOT NULL DEFAULT '',
  "path_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "projects_identity_idx"
  ON "projects" ("repo_hash", "remote_hash", "path_hash");

CREATE TABLE IF NOT EXISTS "usage_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "occurred_at" timestamptz NOT NULL,
  "ingested_at" timestamptz NOT NULL DEFAULT now(),
  "tool_id" uuid NOT NULL REFERENCES "tools" ("id"),
  "device_id" uuid NOT NULL REFERENCES "devices" ("id"),
  "project_id" uuid NOT NULL REFERENCES "projects" ("id"),
  "source_event_id" text NOT NULL,
  "model" text,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cache_read_tokens" integer NOT NULL DEFAULT 0,
  "cache_write_tokens" integer NOT NULL DEFAULT 0,
  "total_tokens" integer NOT NULL,
  "cost_usd" numeric,
  "raw_meta_json" jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS "usage_events_source_unique"
  ON "usage_events" ("device_id", "tool_id", "source_event_id");

CREATE TABLE IF NOT EXISTS "daily_usage_rollups" (
  "day" date NOT NULL,
  "tool_id" uuid NOT NULL REFERENCES "tools" ("id"),
  "device_id" uuid NOT NULL REFERENCES "devices" ("id"),
  "project_id" uuid NOT NULL REFERENCES "projects" ("id"),
  "model" text NOT NULL DEFAULT 'unknown',
  "event_count" integer NOT NULL DEFAULT 0,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cache_read_tokens" integer NOT NULL DEFAULT 0,
  "cache_write_tokens" integer NOT NULL DEFAULT 0,
  "total_tokens" integer NOT NULL DEFAULT 0,
  "cost_usd" numeric NOT NULL DEFAULT '0',
  CONSTRAINT "daily_usage_rollups_pk"
    PRIMARY KEY ("day", "tool_id", "device_id", "project_id", "model")
);

CREATE TABLE IF NOT EXISTS "model_prices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tool_id" uuid REFERENCES "tools" ("id"),
  "model" text NOT NULL,
  "input_cost_per_million_usd" numeric NOT NULL DEFAULT 0,
  "output_cost_per_million_usd" numeric NOT NULL DEFAULT 0,
  "cache_read_cost_per_million_usd" numeric NOT NULL DEFAULT 0,
  "cache_write_cost_per_million_usd" numeric NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "model_prices_model_unique"
  ON "model_prices" ("model");

INSERT INTO "tools" ("slug", "display_name")
VALUES
  ('codex-cli', 'Codex CLI'),
  ('codex-vscode-plugin', 'Codex VS Code'),
  ('codex-desktop', 'Codex Desktop'),
  ('other', 'Other')
ON CONFLICT ("slug") DO UPDATE
SET "display_name" = excluded."display_name";

INSERT INTO "model_prices" (
  "model",
  "input_cost_per_million_usd",
  "output_cost_per_million_usd",
  "cache_read_cost_per_million_usd",
  "cache_write_cost_per_million_usd"
)
VALUES
  ('gpt-5.6', 5.00, 30.00, 0.50, 6.25),
  ('gpt-5.6-sol', 5.00, 30.00, 0.50, 6.25),
  ('gpt-5.6-terra', 2.50, 15.00, 0.25, 3.125),
  ('gpt-5.6-luna', 1.00, 6.00, 0.10, 1.25)
ON CONFLICT ("model") DO UPDATE
SET
  "input_cost_per_million_usd" = excluded."input_cost_per_million_usd",
  "output_cost_per_million_usd" = excluded."output_cost_per_million_usd",
  "cache_read_cost_per_million_usd" = excluded."cache_read_cost_per_million_usd",
  "cache_write_cost_per_million_usd" = excluded."cache_write_cost_per_million_usd",
  "updated_at" = now();
