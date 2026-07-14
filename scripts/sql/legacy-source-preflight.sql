DO $$
BEGIN
  IF to_regclass('public.devices') IS NULL
    OR to_regclass('public.tools') IS NULL
    OR to_regclass('public.projects') IS NULL
    OR to_regclass('public.usage_events') IS NULL
    OR EXISTS (
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
      )
      SELECT 1
      FROM required
      LEFT JOIN information_schema.columns
        ON columns.table_schema = 'public'
       AND columns.table_name = required.table_name
       AND columns.column_name = required.column_name
      WHERE columns.column_name IS NULL
    ) THEN
    RAISE EXCEPTION 'source schema is missing required tables or columns';
  END IF;
END
$$;

SELECT current_database() AS database_name, true AS schema_valid;
