COPY (
  SELECT
    t.slug AS legacy_tool_slug,
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
  WHERE t.slug IN (:eligible_slugs_sql)
  GROUP BY t.slug, coalesce(e.model, 'unknown')
  ORDER BY t.slug, coalesce(e.model, 'unknown')
) TO STDOUT WITH (FORMAT csv);
