BEGIN;

SELECT pg_advisory_xact_lock(hashtext('codex-usage-dashboard-legacy-import'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM _legacy_import.events AS e
    LEFT JOIN _legacy_import.tool_map AS m ON m.legacy_slug = e.legacy_tool_slug
    WHERE m.legacy_slug IS NULL
  ) THEN
    RAISE EXCEPTION 'legacy source slug has no target mapping';
  END IF;

  IF (SELECT count(*) FROM _legacy_import.expected_metrics) <> 1 THEN
    RAISE EXCEPTION 'expected source metrics row is missing or duplicated';
  END IF;
END
$$;

INSERT INTO devices (
  id, name, os, hostname_hash, device_token_hash,
  last_seen_at, disabled_at, created_at, updated_at
)
SELECT
  id, name, os, hostname_hash, device_token_hash,
  last_seen_at, disabled_at, created_at, updated_at
FROM _legacy_import.devices;

INSERT INTO projects (
  id, display_name, repo_hash, remote_hash, path_hash, created_at, updated_at
)
SELECT id, display_name, repo_hash, remote_hash, path_hash, created_at, updated_at
FROM _legacy_import.projects;

INSERT INTO usage_events (
  id, occurred_at, ingested_at, tool_id, device_id, project_id,
  source_event_id, task_id, model, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, raw_meta_json
)
SELECT
  e.id,
  e.occurred_at,
  e.ingested_at,
  t.id,
  e.device_id,
  e.project_id,
  e.source_event_id,
  'fallback:' || e.device_id::text,
  e.model,
  e.input_tokens,
  e.output_tokens,
  e.cache_read_tokens,
  e.cache_write_tokens,
  e.total_tokens,
  e.cost_usd,
  e.raw_meta_json
FROM _legacy_import.events AS e
JOIN _legacy_import.tool_map AS m ON m.legacy_slug = e.legacy_tool_slug
JOIN tools AS t ON t.slug = m.target_slug;

DELETE FROM daily_usage_rollups;

INSERT INTO daily_usage_rollups (
  day, tool_id, device_id, project_id, model, event_count,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  total_tokens, cost_usd
)
SELECT
  (occurred_at AT TIME ZONE 'Asia/Tokyo')::date,
  tool_id,
  device_id,
  project_id,
  coalesce(model, 'unknown'),
  count(*)::integer,
  coalesce(sum(input_tokens), 0)::integer,
  coalesce(sum(output_tokens), 0)::integer,
  coalesce(sum(cache_read_tokens), 0)::integer,
  coalesce(sum(cache_write_tokens), 0)::integer,
  coalesce(sum(total_tokens), 0)::integer,
  coalesce(sum(cost_usd), 0)
FROM usage_events
GROUP BY
  (occurred_at AT TIME ZONE 'Asia/Tokyo')::date,
  tool_id,
  device_id,
  project_id,
  coalesce(model, 'unknown');

DO $$
DECLARE
  expected _legacy_import.expected_metrics%ROWTYPE;
  actual record;
  rollup record;
BEGIN
  SELECT * INTO STRICT expected FROM _legacy_import.expected_metrics;
  SELECT
    count(*)::bigint AS event_count,
    coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
    coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
    coalesce(sum(cache_read_tokens), 0)::bigint AS cache_read_tokens,
    coalesce(sum(cache_write_tokens), 0)::bigint AS cache_write_tokens,
    coalesce(sum(total_tokens), 0)::bigint AS total_tokens,
    coalesce(sum(cost_usd), 0)::numeric AS cost_usd
  INTO actual
  FROM usage_events;

  IF actual.event_count <> expected.event_count
    OR actual.input_tokens <> expected.input_tokens
    OR actual.output_tokens <> expected.output_tokens
    OR actual.cache_read_tokens <> expected.cache_read_tokens
    OR actual.cache_write_tokens <> expected.cache_write_tokens
    OR actual.total_tokens <> expected.total_tokens
    OR actual.cost_usd <> expected.cost_usd THEN
    RAISE EXCEPTION 'target aggregate verification failed';
  END IF;

  IF EXISTS (
    WITH expected_groups AS (
      SELECT
        m.target_slug AS slug,
        g.model,
        sum(g.event_count)::bigint AS event_count,
        sum(g.input_tokens)::bigint AS input_tokens,
        sum(g.output_tokens)::bigint AS output_tokens,
        sum(g.cache_read_tokens)::bigint AS cache_read_tokens,
        sum(g.cache_write_tokens)::bigint AS cache_write_tokens,
        sum(g.total_tokens)::bigint AS total_tokens,
        sum(g.cost_usd)::numeric AS cost_usd
      FROM _legacy_import.expected_group_metrics AS g
      JOIN _legacy_import.tool_map AS m ON m.legacy_slug = g.legacy_tool_slug
      GROUP BY m.target_slug, g.model
    ), actual_groups AS (
      SELECT
        t.slug,
        coalesce(e.model, 'unknown') AS model,
        count(*)::bigint AS event_count,
        coalesce(sum(e.input_tokens), 0)::bigint AS input_tokens,
        coalesce(sum(e.output_tokens), 0)::bigint AS output_tokens,
        coalesce(sum(e.cache_read_tokens), 0)::bigint AS cache_read_tokens,
        coalesce(sum(e.cache_write_tokens), 0)::bigint AS cache_write_tokens,
        coalesce(sum(e.total_tokens), 0)::bigint AS total_tokens,
        coalesce(sum(e.cost_usd), 0)::numeric AS cost_usd
      FROM usage_events AS e
      JOIN tools AS t ON t.id = e.tool_id
      GROUP BY t.slug, coalesce(e.model, 'unknown')
    )
    (SELECT * FROM expected_groups EXCEPT SELECT * FROM actual_groups)
    UNION ALL
    (SELECT * FROM actual_groups EXCEPT SELECT * FROM expected_groups)
  ) THEN
    RAISE EXCEPTION 'target grouped verification failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM usage_events AS e
    LEFT JOIN devices AS d ON d.id = e.device_id
    LEFT JOIN projects AS p ON p.id = e.project_id
    WHERE d.id IS NULL OR p.id IS NULL
  ) THEN
    RAISE EXCEPTION 'target contains orphaned events';
  END IF;

  SELECT
    coalesce(sum(event_count), 0)::bigint AS event_count,
    coalesce(sum(total_tokens), 0)::bigint AS total_tokens,
    coalesce(sum(cost_usd), 0)::numeric AS cost_usd
  INTO rollup
  FROM daily_usage_rollups;

  IF rollup.event_count <> actual.event_count
    OR rollup.total_tokens <> actual.total_tokens
    OR rollup.cost_usd <> actual.cost_usd THEN
    RAISE EXCEPTION 'target rollup verification failed';
  END IF;
END
$$;

DROP SCHEMA _legacy_import CASCADE;

COMMIT;
