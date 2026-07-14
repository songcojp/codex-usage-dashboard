WITH target_state AS (
  SELECT
    to_regclass('public._migrations') AS migrations_table,
    (SELECT count(*) FROM usage_events) AS event_count,
    (SELECT count(*) FROM devices) AS device_count,
    (SELECT count(*) FROM projects) AS project_count,
    (SELECT count(*) FROM daily_usage_rollups) AS rollup_count
)
SELECT
  current_database() AS database_name,
  CASE
    WHEN migrations_table IS NULL THEN 'target schema migrations have not completed'::boolean
    WHEN event_count <> 0 THEN 'target usage_events must be empty'::boolean
    WHEN device_count <> 0 OR project_count <> 0 OR rollup_count <> 0
      THEN 'target business tables must be empty'::boolean
    ELSE true
  END AS target_valid
FROM target_state;
