CREATE TABLE IF NOT EXISTS "usage_event_cleanup_backups" (
  "batch_id" uuid NOT NULL,
  "usage_event_id" uuid NOT NULL,
  "backed_up_at" timestamptz NOT NULL DEFAULT now(),
  "row_data" jsonb NOT NULL,
  CONSTRAINT "usage_event_cleanup_backups_pk"
    PRIMARY KEY ("batch_id", "usage_event_id")
);

CREATE INDEX IF NOT EXISTS "usage_event_cleanup_backups_event_idx"
  ON "usage_event_cleanup_backups" ("usage_event_id");
