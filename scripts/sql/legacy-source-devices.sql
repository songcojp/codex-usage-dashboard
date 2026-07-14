COPY (
  SELECT DISTINCT
    d.id,
    d.name,
    d.os,
    d.hostname_hash,
    d.device_token_hash,
    d.last_seen_at,
    d.disabled_at,
    d.created_at,
    d.updated_at
  FROM devices AS d
  JOIN usage_events AS e ON e.device_id = d.id
  JOIN tools AS t ON t.id = e.tool_id
  WHERE t.slug IN (:eligible_slugs_sql)
  ORDER BY d.id
) TO STDOUT WITH (FORMAT csv);
