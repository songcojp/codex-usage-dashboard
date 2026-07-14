WITH required(table_name, column_name) AS (
  VALUES
    ('devices', 'id'),
    ('devices', 'device_token_hash'),
    ('tools', 'id'),
    ('tools', 'slug'),
    ('projects', 'id'),
    ('projects', 'path_hash'),
    ('usage_events', 'id'),
    ('usage_events', 'tool_id'),
    ('usage_events', 'device_id'),
    ('usage_events', 'project_id'),
    ('usage_events', 'source_event_id'),
    ('usage_events', 'raw_meta_json')
), present AS (
  SELECT count(*)::integer AS count
  FROM required
  JOIN information_schema.columns
    ON columns.table_schema = 'public'
   AND columns.table_name = required.table_name
   AND columns.column_name = required.column_name
), required_tables AS (
  SELECT
    to_regclass('public.devices') AS devices,
    to_regclass('public.tools') AS tools,
    to_regclass('public.projects') AS projects,
    to_regclass('public.usage_events') AS usage_events
)
SELECT
  current_database() AS database_name,
  CASE
    WHEN present.count = (SELECT count(*) FROM required)
      AND required_tables.devices IS NOT NULL
      AND required_tables.tools IS NOT NULL
      AND required_tables.projects IS NOT NULL
      AND required_tables.usage_events IS NOT NULL THEN true
    ELSE 'source schema is missing required tables or columns'::boolean
  END AS schema_valid
FROM present
CROSS JOIN required_tables;
