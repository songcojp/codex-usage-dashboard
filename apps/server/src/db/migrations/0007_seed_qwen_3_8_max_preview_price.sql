-- qwen3.8-max-preview is Token Plan only. This seed uses the current
-- regular-time promotional estimate converted into the dashboard's USD/1M
-- token schema:
--   qwen3.7-max Beijing domestic Max baseline: ¥12 input / ¥36 output per 1M
--   qwen3.8-max-preview regular-time Token Plan multiplier: 0.05x
--   explicit context cache: 10% read, 125% write
--   USD/CNY reference: 6.77275
INSERT INTO "model_prices" (
  "model",
  "input_cost_per_million_usd",
  "output_cost_per_million_usd",
  "cache_read_cost_per_million_usd",
  "cache_write_cost_per_million_usd"
)
VALUES
  ('qwen3.8-max-preview', 0.0886, 0.2658, 0.0089, 0.1107)
ON CONFLICT ("model") DO NOTHING;

UPDATE "usage_events" AS "event"
SET "cost_usd" = (
  (
    "event"."input_tokens" * "price"."input_cost_per_million_usd" +
    "event"."output_tokens" * "price"."output_cost_per_million_usd" +
    "event"."cache_read_tokens" * "price"."cache_read_cost_per_million_usd" +
    "event"."cache_write_tokens" * "price"."cache_write_cost_per_million_usd"
  ) / 1000000
)
FROM "model_prices" AS "price"
WHERE "event"."model" = 'qwen3.8-max-preview'
  AND "price"."model" = 'qwen3.8-max-preview';

DELETE FROM "daily_usage_rollups"
WHERE "daily_usage_rollups"."model" = 'qwen3.8-max-preview';

INSERT INTO "daily_usage_rollups" (
  "day",
  "tool_id",
  "device_id",
  "project_id",
  "model",
  "event_count",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
  "cost_usd"
)
SELECT
  ("event"."occurred_at" AT TIME ZONE 'Asia/Tokyo')::date,
  "event"."tool_id",
  "event"."device_id",
  "event"."project_id",
  "event"."model",
  count(*)::integer,
  sum("event"."input_tokens"),
  sum("event"."output_tokens"),
  sum("event"."cache_read_tokens"),
  sum("event"."cache_write_tokens"),
  sum("event"."total_tokens"),
  sum(coalesce("event"."cost_usd", 0))
FROM "usage_events" AS "event"
WHERE "event"."model" = 'qwen3.8-max-preview'
GROUP BY
  ("event"."occurred_at" AT TIME ZONE 'Asia/Tokyo')::date,
  "event"."tool_id",
  "event"."device_id",
  "event"."project_id",
  "event"."model";
