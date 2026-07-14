# Watcher-only Agent design

## Status

Approved direction: replace scheduled scans with one long-running watcher process. The watcher performs real-time incremental ingestion and an internal reconciliation every six hours. Compatibility with the legacy Agent executable, configuration, commands, and source aliases is out of scope.

This document is limited to the Agent runtime and its installer. It does not change the dashboard data model, Codex Desktop classification, or the rule that unknown Codex origins are reported as `other`.

## Goals

- Run exactly one automatic Agent process per device.
- Upload new Codex usage shortly after its source log is appended.
- Avoid reparsing and requeueing an entire live log after every file change.
- Recover from missed filesystem notifications, newly created directories, log rotation, temporary read failures, network outages, and process restarts.
- Ensure only one process owns the cursor state and upload queue.
- Keep installation and operations consistent on Linux and Windows without a separate scheduled scan task.

## Non-goals

- Supporting the legacy Agent binary or its configuration directory.
- Accepting removed legacy tool slugs in the new Agent.
- Collecting or preserving non-Codex sources.
- Running a second process as a scheduled fallback.
- Guaranteeing that filesystem notifications alone provide delivery.

## Runtime architecture

The Agent exposes one automatic execution command, `watch`. It always scans and uploads; the current optional `--upload` behavior is removed. Diagnostic commands such as `status` and the explicit state-reset operation may remain, but they must not run an independent ingestion loop.

One watcher process owns four responsibilities:

1. Discover configured Codex source files.
2. Read only bytes added since each file's committed cursor.
3. durably enqueue parsed events and upload the queue.
4. Reconcile the source tree every six hours.

The process takes an exclusive lock in the Agent configuration directory before opening the queue or state. A second watcher exits with a clear error. A stale lock left by an unclean exit is recoverable only after confirming that its recorded process is no longer running.

On Linux, systemd restarts the watcher after failures. On Windows, a single logon-started watcher task replaces the current watcher-plus-scheduled-scan pair.

## File discovery and notifications

The watcher begins with a reconciliation pass. It recursively discovers files through the existing parser adapters, registers directory watches, and processes every file whose saved cursor is behind its current size.

Filesystem notifications are hints rather than the source of truth. A notification schedules a debounced pass for the affected path. Directory creation refreshes the watch registry so newly created Codex session directories are observed. When a platform omits the changed filename, the watcher reconciles the notified directory.

Every six hours, the same process runs a complete discovery and cursor comparison. This catches missed notifications, directories created during a watcher-registration race, and files changed while the process was stopped. The reconciliation is serialized with notification-driven work; the two paths never scan concurrently.

## Incremental parser contract

Parser adapters change from whole-file parsing to a cursor-based contract. An adapter receives a file path, a byte range, and its saved parser context, then returns:

- parsed events;
- the next byte offset;
- the next parser context;
- any incomplete trailing bytes that must wait for the next append.

Codex JSONL parser context includes the active session ID, working directory, model, and independently classified tool type. This allows a token-count record appended later to retain the context established earlier in the file. Codex Desktop remains `codex-desktop`; VS Code remains `codex-vscode-plugin`; CLI remains `codex-cli`; an unrecognized Codex origin remains `other`.

The VS Code log adapter keeps only the minimal context required by its line format. Both adapters ignore an incomplete final line until a newline or a later stable read completes it.

For the same source record, the incremental parsers must preserve the source event ID produced by the current new-project parsers. Changing read strategy must not make already ingested history appear to be new data.

## Cursor and rotation handling

The state format is versioned and stores one record per canonical source path:

- file identity where the platform exposes it;
- byte offset;
- observed size and modification time;
- parser context;
- incomplete trailing bytes, subject to a small fixed size limit.

A file is treated as replaced or rotated when its identity changes or its size becomes smaller than the committed offset. The new file starts from offset zero with empty parser context. Renamed historical files are discovered during reconciliation and are safe to parse because stable source event IDs and server uniqueness prevent duplicate database rows.

State writes use a temporary file, file synchronization, and atomic rename. Corrupt or unsupported state versions stop ingestion with an actionable error instead of silently rescanning all history.

## Queue and commit ordering

For each incremental read, the Agent performs these steps in order:

1. Parse a stable byte range.
2. Append new events to the durable queue.
3. Synchronize the queue to disk.
4. Atomically commit the new cursor and parser context.
5. Attempt upload.

Advancing the cursor before the queue is durable is forbidden because it can lose events after a crash. If a crash occurs after queue append but before cursor commit, the next run may parse the range again. Enqueue therefore deduplicates by the pair `(toolSlug, sourceEventId)`. The server's existing uniqueness constraint remains the final idempotency boundary.

Only the watcher mutates the queue. Successful uploads remove acknowledged batches without discarding later records appended during the request. Failed uploads retain all unacknowledged events.

## Upload retry behavior

New events trigger an immediate upload attempt. Network errors, non-success responses, and temporary server failures retain the queue and schedule exponential backoff starting at 30 seconds and capped at 30 minutes. A successful upload resets the backoff.

Source processing continues while the server is unavailable until the queue reaches 100 MiB. Reaching that fixed safety limit stops advancing source cursors and emits a clear error so disk usage cannot grow without bound. The next successful upload resumes source processing.

Authentication failures are not treated as transient. The watcher keeps the queue, reports the failure, and retries no more than once every 30 minutes so a corrected configuration can recover without a process restart.

## Configuration and compatibility boundary

The only supported configuration directory is the Codex Usage Dashboard Agent directory. The obsolete `scanInterval` field is removed. Supported configured source keys remain the new Codex-only keys.

No client-side migration from the legacy project's configuration directory, queue, state, commands, service names, or source aliases is provided. Existing server-side acceptance of the currently deployed device credential is independent of the Agent execution-mode change and remains in place so the production device is not unnecessarily re-enrolled.

The currently deployed new-project Agent uses the supported configuration directory but has an unversioned fingerprint-only state. The installer archives that state before creating the versioned cursor state. Because the old state cannot supply safe byte offsets and parser context, the first watcher startup reconciles from offset zero. Stable source event IDs and server uniqueness make this replay idempotent. The existing new-project upload queue is preserved and drained before new source ranges are processed.

## Installer and service cutover

The Linux installer writes one long-running `codex-usage-dashboard-agent.service` whose command is `watch`. During installation it stops, disables, and removes the obsolete units created by earlier new-project releases:

- `codex-usage-dashboard-agent.timer`;
- the one-shot scan version of `codex-usage-dashboard-agent.service`;
- `codex-usage-dashboard-agent-watch.service`.

It then reloads the user systemd manager and enables the replacement service. The transition must not delete the queue. It archives the earlier new-project fingerprint state as described above and never treats that archive as active cursor state.

The Windows installer emits one watcher-at-logon task and removes the scheduled scan task. There is no hourly or daily scheduling option on either platform.

## Observability

Each processing cycle emits one structured record containing its reason (`startup`, `filesystem`, `reconciliation`, or `retry`), files advanced, events queued, events uploaded, queue depth, and next retry time. It must not log device tokens, source contents, prompts, absolute project paths, or raw metadata.

The `status` command reports watcher health from state without starting a scan: last successful source advance, last successful upload, last reconciliation, tracked file count, queue depth, and last error category.

## Verification strategy

Unit coverage must demonstrate:

- appended JSONL content advances a cursor and emits only new events;
- parser context survives across separate appends;
- incomplete trailing records wait for completion;
- truncation and rotation reset the affected cursor safely;
- unknown Codex origins become `other` while Desktop remains independent;
- queue append precedes cursor commit;
- a simulated crash window cannot create an unbounded duplicate queue;
- notification work and reconciliation are serialized;
- upload failures retain the queue and follow bounded backoff;
- a second watcher cannot acquire the state lock;
- installer output contains one watcher service and no timer.

An integration test uses temporary source logs and a local ingest endpoint. It starts the watcher, appends records in multiple writes, rotates a file, creates a new nested directory, simulates an upload outage, and verifies that every accepted event is eventually delivered without queue growth from repeated whole-file parsing.

Deployment verification must confirm that the replacement service is active, both obsolete units are disabled or absent, the existing queue is empty or preserved, the earlier state archive exists, a newly appended real Codex record is uploaded, and the reconciliation timestamp is recorded. The six-hour interval is verified with a controlled clock in automated tests rather than waiting six hours during deployment. The production database count must only increase by genuinely new source event IDs.

## Rollout and rollback

The rollout builds and tests the new Agent, installs the replacement service without deleting state, and observes one real upload before considering the cutover complete. The existing hourly timer remains disabled throughout the rollout.

Rollback restores the previous new-project Agent package and its hourly timer from the release artifact. It does not restore the legacy project Agent. Queue and state backups are taken before service replacement so rollback does not discard events collected while the server was unavailable.
