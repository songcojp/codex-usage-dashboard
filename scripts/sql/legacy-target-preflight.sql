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

SELECT current_database() AS database_name, true AS target_valid;
