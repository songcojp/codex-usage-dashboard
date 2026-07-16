# Task ID Collection and Backfill Design

## Goal

Store a Codex task ID on every usage event, recover real task IDs from local Codex logs where possible, and assign every remaining event to one stable fallback task per device.

## Task identity

- Current user Codex session logs use `session_meta.payload.id` as both the source session ID and task ID.
- Subagent session logs use `session_meta.payload.source.subagent.thread_spawn.parent_thread_id` as the task ID. Their own `session_meta.payload.id` remains the source session ID so different child executions retain distinct event identities.
- Legacy Codex usage records use `session_id` as the task ID.
- The Agent sends the task ID as an optional ingest field and sends `sourceSessionId` only when a child session is attributed to a different parent task. Both fields remain optional so older Agents remain compatible during rollout.
- The server owns fallback assignment. Each device has one deterministic fallback task ID derived from its database device ID. Events from different devices never share a fallback task.

## Ingest and persistence

Add a non-null `task_id` column to `usage_events`. The database migration assigns every existing row its device-specific fallback task before enforcing the non-null constraint.

For new events, the server persists the supplied real task ID. When an older Agent omits the field, the server persists that device's fallback task ID.

The existing uniqueness boundary `(device_id, tool_id, source_event_id)` remains unchanged. Current-session source event IDs continue to use the source session ID, including the child session ID for subagents.

When a replayed event conflicts with an existing event, the server may replace its task ID only when the stored value is either:

- that device's fallback task ID; or
- the replay's `sourceSessionId`, when the event is being reassigned from a child session to its parent task.

It never permits an unrelated real task ID to be overwritten and never changes token, cost, project, model, or rollup fields during backfill.

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
2. Deploy the server version that accepts `sourceSessionId` and restricts child-to-parent reassignment.
3. Deploy or install the Agent version that groups subagents under their parent task and exposes the backfill command.
4. Run `backfill-task-ids --confirm` once on each device that still has historical Codex logs. This repairs both fallback task IDs and historical child-session task IDs.
5. Verify database counts for parent tasks and per-device fallback tasks.

Running the historical rescan against an older server is forbidden because the older ingest contract cannot persist task IDs.

## Tests

- Current `session_meta` records attach their task ID to emitted token events.
- Subagent records attach the parent thread ID as `taskId`, retain the child ID as `sourceSessionId`, and keep child-based source event IDs.
- Legacy records attach `session_id` to emitted usage events.
- Missing task IDs remain optional at the ingest boundary for old-Agent compatibility.
- New events without a task ID receive the correct device fallback.
- Duplicate events replace fallback with a recovered real task ID.
- Duplicate subagent events replace a matching child-session task ID with the parent task ID.
- Duplicate events never replace an unrelated real task ID.
- Different devices receive different fallback task IDs.
- Database migration backfills all existing rows and enforces non-null task IDs.
- Historical rescan starts at the beginning, uses bounded batches, and leaves watcher state unchanged.
- Re-running the rescan is idempotent.
