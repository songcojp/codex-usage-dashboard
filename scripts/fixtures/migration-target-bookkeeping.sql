CREATE TABLE IF NOT EXISTS _migrations (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO _migrations (name, checksum)
VALUES ('0001_initial.sql', 'migration-test-checksum')
ON CONFLICT (name) DO NOTHING;
