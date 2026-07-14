ALTER TABLE "usage_events"
  ALTER COLUMN "input_tokens" TYPE bigint,
  ALTER COLUMN "output_tokens" TYPE bigint,
  ALTER COLUMN "cache_read_tokens" TYPE bigint,
  ALTER COLUMN "cache_write_tokens" TYPE bigint,
  ALTER COLUMN "total_tokens" TYPE bigint;

ALTER TABLE "daily_usage_rollups"
  ALTER COLUMN "input_tokens" TYPE bigint,
  ALTER COLUMN "output_tokens" TYPE bigint,
  ALTER COLUMN "cache_read_tokens" TYPE bigint,
  ALTER COLUMN "cache_write_tokens" TYPE bigint,
  ALTER COLUMN "total_tokens" TYPE bigint;
