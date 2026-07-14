INSERT INTO tools (slug, display_name) VALUES
  ('codex-vscode', 'Legacy Codex VS Code'),
  ('codex', 'Legacy Codex'),
  ('codex-private-legacy', 'Private Legacy Codex'),
  ('legacy-non-codex', 'Non-Codex')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO devices (
  id, name, os, hostname_hash, device_token_hash, created_at, updated_at
) VALUES
  ('10000000-0000-4000-8000-000000000001', 'Eligible Device', 'linux', 'eligible-hostname-hash', 'eligible-device-token-hash', now(), now()),
  ('20000000-0000-4000-8000-000000000002', 'Excluded Device', 'linux', 'excluded-hostname-hash', 'excluded-device-token-hash', now(), now());

INSERT INTO projects (
  id, display_name, repo_hash, remote_hash, path_hash, created_at, updated_at
) VALUES
  ('30000000-0000-4000-8000-000000000003', 'Eligible Project', 'eligible-repo-hash', 'eligible-remote-hash', 'eligible-path-hash', now(), now()),
  ('40000000-0000-4000-8000-000000000004', 'Excluded Project', 'excluded-repo-hash', 'excluded-remote-hash', 'excluded-path-hash', now(), now());

INSERT INTO usage_events (
  id, occurred_at, ingested_at, tool_id, device_id, project_id,
  source_event_id, model, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, raw_meta_json
) VALUES
  ('50000000-0000-4000-8000-000000000001', '2026-07-01T00:00:00Z', '2026-07-01T00:01:00Z', (SELECT id FROM tools WHERE slug = 'codex-cli'), '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003', 'eligible-event-cli', 'gpt-5', 10, 1, 2, 3, 16, 0.1, '{"fixture":true}'),
  ('50000000-0000-4000-8000-000000000002', '2026-07-01T01:00:00Z', '2026-07-01T01:01:00Z', (SELECT id FROM tools WHERE slug = 'codex-vscode'), '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003', 'eligible-event-vscode', 'gpt-5', 20, 2, 3, 4, 29, 0.2, '{"fixture":true}'),
  ('50000000-0000-4000-8000-000000000003', '2026-07-01T02:00:00Z', '2026-07-01T02:01:00Z', (SELECT id FROM tools WHERE slug = 'codex-desktop'), '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003', 'eligible-event-desktop', 'gpt-5', 30, 3, 4, 5, 42, 0.3, '{"fixture":true}'),
  ('50000000-0000-4000-8000-000000000004', '2026-07-01T03:00:00Z', '2026-07-01T03:01:00Z', (SELECT id FROM tools WHERE slug = 'codex'), '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003', 'eligible-event-generic', 'gpt-5', 40, 4, 5, 6, 55, 0.4, '{"fixture":true}'),
  ('50000000-0000-4000-8000-000000000005', '2026-07-01T04:00:00Z', '2026-07-01T04:01:00Z', (SELECT id FROM tools WHERE slug = 'codex-private-legacy'), '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003', 'eligible-event-private', 'gpt-5', 50, 5, 6, 7, 68, 0.5, '{"fixture":true}'),
  ('50000000-0000-4000-8000-000000000006', '2026-07-01T05:00:00Z', '2026-07-01T05:01:00Z', (SELECT id FROM tools WHERE slug = 'legacy-non-codex'), '20000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000004', 'excluded-event', 'other-model', 60, 6, 7, 8, 81, 0.6, '{"fixture":true}');
