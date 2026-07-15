ALTER TABLE "usage_events" ADD COLUMN "task_id" text;

UPDATE "usage_events"
SET "task_id" = 'fallback:' || "device_id"::text
WHERE "task_id" IS NULL;

ALTER TABLE "usage_events" ALTER COLUMN "task_id" SET NOT NULL;

CREATE INDEX "usage_events_device_task_idx"
  ON "usage_events" ("device_id", "task_id");
