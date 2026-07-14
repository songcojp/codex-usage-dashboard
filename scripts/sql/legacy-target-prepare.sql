BEGIN;

SELECT pg_advisory_xact_lock(hashtext('codex-usage-dashboard-legacy-import'));

DO $$
BEGIN
  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION 'target schema migrations have not completed';
  END IF;

  IF EXISTS (SELECT 1 FROM usage_events) THEN
    RAISE EXCEPTION 'target usage_events must be empty';
  END IF;

  IF EXISTS (SELECT 1 FROM devices)
    OR EXISTS (SELECT 1 FROM projects)
    OR EXISTS (SELECT 1 FROM daily_usage_rollups) THEN
    RAISE EXCEPTION 'target business tables must be empty';
  END IF;
END
$$;

DROP SCHEMA IF EXISTS _legacy_import CASCADE;
CREATE SCHEMA _legacy_import;

CREATE TABLE _legacy_import.devices (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  os text NOT NULL,
  hostname_hash text NOT NULL,
  device_token_hash text NOT NULL,
  last_seen_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE _legacy_import.projects (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  repo_hash text NOT NULL,
  remote_hash text NOT NULL,
  path_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE _legacy_import.events (
  legacy_tool_slug text NOT NULL,
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL,
  device_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_event_id text NOT NULL,
  model text,
  input_tokens integer NOT NULL,
  output_tokens integer NOT NULL,
  cache_read_tokens integer NOT NULL,
  cache_write_tokens integer NOT NULL,
  total_tokens integer NOT NULL,
  cost_usd numeric,
  raw_meta_json jsonb NOT NULL
);

CREATE TABLE _legacy_import.expected_metrics (
  event_count bigint NOT NULL,
  input_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  cache_read_tokens bigint NOT NULL,
  cache_write_tokens bigint NOT NULL,
  total_tokens bigint NOT NULL,
  cost_usd numeric NOT NULL
);

CREATE TABLE _legacy_import.expected_group_metrics (
  legacy_tool_slug text NOT NULL,
  model text NOT NULL,
  event_count bigint NOT NULL,
  input_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  cache_read_tokens bigint NOT NULL,
  cache_write_tokens bigint NOT NULL,
  total_tokens bigint NOT NULL,
  cost_usd numeric NOT NULL,
  PRIMARY KEY (legacy_tool_slug, model)
);

CREATE TABLE _legacy_import.tool_map (
  legacy_slug text PRIMARY KEY,
  target_slug text NOT NULL
);

INSERT INTO _legacy_import.tool_map (legacy_slug, target_slug) VALUES
  ('codex-cli', 'codex-cli'),
  ('codex-vscode', 'codex-vscode-plugin'),
  ('codex-vscode-plugin', 'codex-vscode-plugin'),
  ('codex-desktop', 'codex-desktop'),
  ('codex', 'other');

COMMIT;
