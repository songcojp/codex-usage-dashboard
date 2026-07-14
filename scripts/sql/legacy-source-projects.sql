COPY (
  SELECT DISTINCT
    p.id,
    p.display_name,
    p.repo_hash,
    p.remote_hash,
    p.path_hash,
    p.created_at,
    p.updated_at
  FROM projects AS p
  JOIN usage_events AS e ON e.project_id = p.id
  JOIN tools AS t ON t.id = e.tool_id
  WHERE t.slug IN (:eligible_slugs_sql)
  ORDER BY p.id
) TO STDOUT WITH (FORMAT csv);
