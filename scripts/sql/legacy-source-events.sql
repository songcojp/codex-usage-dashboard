COPY (
  SELECT
    t.slug AS legacy_tool_slug,
    e.id,
    e.occurred_at,
    e.ingested_at,
    e.device_id,
    e.project_id,
    e.source_event_id,
    e.model,
    e.input_tokens,
    e.output_tokens,
    e.cache_read_tokens,
    e.cache_write_tokens,
    e.total_tokens,
    e.cost_usd,
    e.raw_meta_json
  FROM usage_events AS e
  JOIN tools AS t ON t.id = e.tool_id
  WHERE t.slug IN (:eligible_slugs_sql)
  ORDER BY e.id
) TO STDOUT WITH (FORMAT csv);
