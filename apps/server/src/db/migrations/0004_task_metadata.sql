CREATE TABLE "task_metadata" (
  "task_id" text PRIMARY KEY,
  "title" text NOT NULL,
  "source_updated_at" timestamp with time zone NOT NULL,
  "device_id" uuid NOT NULL REFERENCES "devices" ("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
