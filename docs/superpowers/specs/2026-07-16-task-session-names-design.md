# Task and Session Names Design

## Goal

Collect Codex task and session names from workstation-local Codex metadata, synchronize both current and historically recoverable names to the server, and show those names in the Tasks table without changing usage aggregation, filtering, sorting, or pagination.

The dashboard treats a Codex task, session, and thread as the same identity. The existing `taskId` is the `session_meta.payload.id` value from a Codex session log. A name is optional metadata associated with that identity.

## Product Decisions

- Name collection and upload are enabled by default.
- Agent startup synchronizes every recoverable historical name, including tasks that no longer produce usage events.
- A missing name never hides a task; the UI falls back to the task ID.
- Fallback task IDs do not receive generated names.
- Name search and name-based sorting are outside this change.
- The privacy documentation explicitly states that task and session names are uploaded because names may contain user-authored task content.

## Source of Truth

The Agent reads `session_index.jsonl` from Codex data directories as the primary name source. Each valid record supplies:

- `id`, used as `taskId`;
- `thread_name`, used as the task name;
- `updated_at`, used to order title revisions.

The Agent locates index files by:

1. walking upward from configured Codex session paths;
2. checking `CODEX_HOME` when set;
3. checking the default `~/.codex` directory.

Resolved paths are deduplicated so multiple configured sources can share one Codex data directory. For historical tasks absent from the index, the Agent also discovers sibling `state_*.sqlite` files and opens them read-only. It reads only the `threads.id`, `threads.title`, and available update timestamp columns. Older Codex versions may store the complete first request in `threads.title`, so the fallback uses the first trimmed line capped at 500 characters as the task label. Every mapped record still passes through the shared task-metadata schema, and missing, locked, or incompatible databases are skipped without blocking usage ingestion.

When both sources contain the same task ID, the revision with the newer source timestamp wins. SQLite fallback revisions are assigned 1ms below their source timestamp so an equal-timestamp `session_index.jsonl` revision remains authoritative now or can replace the fallback later.

## Architecture

Name synchronization is independent from usage-event ingestion:

```text
session_index.jsonl    state_*.sqlite (read-only fallback)
        |                         |
        +------------+------------+
                     v
Agent metadata scanners and acknowledged-name state
        |
        v
POST /api/ingest/tasks
        |
        v
task_metadata
        |
        v
GET /api/admin/tasks
        |
        v
Tasks table
```

Keeping metadata separate prevents the title from being repeated on every usage event, permits historical backfill without replaying usage logs, and permits later title changes without changing token or cost records.

## Shared Ingest Contract

Add a task-metadata batch schema with a maximum of 1,000 tasks per request. Each item contains:

```ts
type TaskMetadataDraft = {
  taskId: string;
  title: string;
  updatedAt: string;
};
```

The title is trimmed, must remain non-empty, and is limited to 500 characters. `updatedAt` must be a valid ISO timestamp. The server returns:

```ts
type TaskMetadataAcknowledgement = {
  inserted: number;
  updated: number;
  stale: number;
  rejected: Array<{ taskId: string; reason: string }>;
};
```

The existing usage-event ingest contract remains unchanged, preserving compatibility with older Agents.

## Server Storage and Update Rules

Add a `task_metadata` table with:

- `task_id` as the primary key;
- `title` as non-null text;
- `source_updated_at` as the Codex-provided revision time;
- `device_id` as the device that supplied the accepted revision;
- `created_at` and `updated_at` server timestamps.

The new `POST /api/ingest/tasks` endpoint uses the existing Device Bearer Token authentication. Each accepted task is handled independently:

- an unknown `taskId` is inserted;
- a known `taskId` is updated only when the incoming `updatedAt` is later than `source_updated_at`;
- an older revision is counted as stale;
- a revision with the same timestamp is counted as stale even if its title differs, preventing nondeterministic cross-device overwrites;
- invalid items are rejected without discarding valid items in the same batch.

Repeated requests are therefore idempotent. Metadata may arrive before or after usage events, so the metadata table does not require a foreign key to a usage event.

## Agent Synchronization

At startup, the Agent reads every discovered index file and compatible Codex state database in full. It also adds each discovered metadata directory to the existing filesystem-watch roots and repeats the scan after relevant filesystem activity. The existing six-hour reconciliation cycle is the fallback for missed notifications.

For each scan, the Agent:

1. parses newline-terminated JSONL records;
2. reads compatible SQLite thread rows through a read-only connection;
3. ignores unrelated or malformed records and defers an incomplete JSONL final line until a later scan;
4. trims titles and rejects empty or over-length values;
5. deduplicates by task ID, retaining the record with the latest valid source timestamp;
6. compares the result with locally persisted acknowledged-name state;
7. uploads only new or changed revisions in batches of at most 1,000;
8. updates acknowledged-name state only after the server acknowledges the corresponding item.

An upload failure leaves local acknowledgement state unchanged. The existing retry scheduler attempts synchronization again, and a process restart performs another full comparison, so names are not lost. A missing index file is an optional-source condition and does not stop token collection.

The Agent status and cycle result include task-name synchronization counts and a non-sensitive error category. They never print task titles.

## Tasks Query and UI

`GET /api/admin/tasks` left-joins `task_metadata` by task ID and adds:

```ts
taskName: string | null;
```

The left join preserves every task that currently appears in the aggregate query. Existing usage predicates, aggregation, sorting, stable task-ID tie-breaking, offset, and limit behavior remain unchanged.

In the Tasks table:

- a named task shows its name as the primary text and its full task ID as secondary monospace text;
- an unnamed task keeps the current task-ID-only presentation;
- complete names and IDs remain available without irreversible truncation;
- fallback tasks keep the existing `Fallback` badge and ID presentation;
- the existing Task column and table navigation remain intact.

No client-side task-name aggregation is introduced.

## Error Handling and Compatibility

- The database migration only adds `task_metadata`; it does not rewrite usage events.
- Older Agents continue using the existing usage ingest endpoint.
- Servers return `taskName: null` for tasks without metadata.
- Malformed local index records and unavailable or incompatible SQLite sources do not block valid records or usage collection.
- Authentication and network failures use the Agent's existing retry and error-category behavior.
- Task names are excluded from console output, error messages, and source-record diagnostics.
- README and security-facing documentation list task and session names among uploaded data.

## Verification

Tests cover:

- index and SQLite discovery across configured paths, `CODEX_HOME`, and the default data directory;
- read-only SQLite parsing for current and older timestamp-column variants;
- JSONL parsing, duplicate IDs, title changes, whitespace, over-length titles, malformed records, and incomplete final lines;
- startup history synchronization, filesystem-triggered updates, periodic reconciliation, retry behavior, and acknowledged-state persistence;
- shared request and response validation;
- endpoint authentication, per-item validation, insertion, newer updates, stale revisions, equal-timestamp conflicts, batching, and idempotency;
- migration packaging and schema declarations;
- task-query left joins and `taskName: null` behavior;
- named, unnamed, and fallback Tasks-table rendering;
- unchanged task pagination, sorting, filtering, and aggregation behavior.

The completed implementation must pass the full repository test suite, typecheck, and build.
