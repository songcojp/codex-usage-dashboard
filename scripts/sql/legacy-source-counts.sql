SELECT
  count(*) FILTER (WHERE t.slug IN (:eligible_slugs_sql)) AS eligible_events,
  count(*) FILTER (WHERE t.slug NOT IN (:eligible_slugs_sql)) AS excluded_events
FROM usage_events AS e
JOIN tools AS t ON t.id = e.tool_id;
