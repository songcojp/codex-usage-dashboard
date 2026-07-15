# Task ID Collection and Backfill Design

## Goal

Store a Codex task ID on every usage event, recover real task IDs from local Codex logs where possible, and assign every remaining event to one stable fallback task per device.

## Task identity

- Current Codex session logs use `session_meta.payload.id` as the task ID.
- Legacy Codex usage records use `session_id` as the task ID.
- The Agent sends the task ID as an optional ingest field so older Agents remain compatible during rollout.
- The server owns fallback assignment. Each device has one deterministic fallback task ID derived from its database device ID. Events from different devices never share a fallback task.

## Ingest and persistence

Add a non-null `task_id` column to `usage_events`. The database migration assigns every existing row its device-specific fallback task before enforcing the non-null constraint.

For new events, the server persists the supplied real task ID. When an older Agent omits the field, the server persists that device's fallback task ID.

The existing uniqueness boundary `(device_id, tool_id, source_event_id)` remains unchanged. When a replayed event conflicts with an existing event, the server may replace its task ID only when the stored value is that device's fallback and the replay supplies a real task ID. It never overwrites one real task ID with another and never changes token or cost fields during backfill.

## Local historical rescan

Add an explicit one-shot Agent backfill command. It reads the configured Codex log sources from the beginning, independently of the watcher's cursor and durable upload queue, and uploads bounded batches through the normal authenticated ingest endpoint.

Reusing normal ingest gives the rescan the existing validation, source-event identity, device authentication, retry-safe duplicate handling, and privacy rules. The command reports scanned, submitted, matched-as-duplicate, inserted, and rejected counts without printing prompts, responses, absolute paths, or raw task content.

The backfill command does not mutate watcher state. Running it again is safe because both event insertion and task-ID enrichment are idempotent.

## Unrecoverable events

Events remain in their device-specific fallback task when:

- the original local log has been deleted;
- the original record cannot be parsed;
- the current device does not possess the source log;
- a replayed source event does not match the stored event identity; or
- the original record had no task ID.

One device therefore has at most one fallback task, while real tasks remain distinct.

## Rollout

1. Deploy the database migration and duplicate-event enrichment behavior.
2. Deploy or install the Agent version that collects task IDs and exposes the backfill command.
3. Run the backfill command once on each device that still has historical Codex logs.
4. Verify database counts for real tasks and per-device fallback tasks.

Running the historical rescan against an older server is forbidden because the older ingest contract cannot persist task IDs.

## Tests

- Current `session_meta` records attach their task ID to emitted token events.
- Legacy records attach `session_id` to emitted usage events.
- Missing task IDs remain optional at the ingest boundary for old-Agent compatibility.
- New events without a task ID receive the correct device fallback.
- Duplicate events replace fallback with a recovered real task ID.
- Duplicate events never replace an existing real task ID.
- Different devices receive different fallback task IDs.
- Database migration backfills all existing rows and enforces non-null task IDs.
- Historical rescan starts at the beginning, uses bounded batches, and leaves watcher state unchanged.
- Re-running the rescan is idempotent.
