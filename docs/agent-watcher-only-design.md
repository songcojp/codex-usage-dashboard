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

The Agent exposes one automatic execution command, `watch`. It always scans and uploads; the current optional `--upload` behavior is removed. The `status` and explicit `reset-state` diagnostic commands remain, but they do not run an independent ingestion loop. The `scan`, `upload`, and `install-scheduler` commands are removed.

One watcher process owns four responsibilities:

1. Discover configured Codex source files.
2. Read only bytes added since each file's committed cursor.
3. Durably enqueue parsed events and upload the queue.
4. Reconcile the source tree every six hours.

The process takes an OS-backed exclusive lock in the Agent configuration directory before opening the queue or state. The operating system releases the lock when the process exits, so PID reuse and stale lock files cannot authorize a second writer. A second watcher exits with a clear error; if an OS-backed lock is unavailable, ingestion fails closed instead of falling back to a PID-only check.

On Linux, systemd restarts the watcher after failures. On Windows, a single logon-started watcher task configured to restart on failure replaces the current watcher-plus-scheduled-scan pair.

## File discovery and notifications

The watcher begins with a reconciliation pass. It recursively discovers files through the existing parser adapters, registers directory watches, and processes every file whose saved cursor is behind its current size.

Filesystem notifications are hints rather than the source of truth. A notification schedules a debounced pass for the affected path. Directory creation refreshes the watch registry so newly created Codex session directories are observed. When a platform omits the changed filename, the watcher reconciles the notified directory.

Every six hours, the same process runs a complete discovery and cursor comparison. This catches missed notifications, directories created during a watcher-registration race, and files changed while the process was stopped. The reconciliation is serialized with notification-driven work; the two paths never scan concurrently.

## Incremental parser contract

Parser adapters change from whole-file parsing to a cursor-based contract. An adapter receives a file path, a byte range, and its saved parser context, then returns:

- parsed events;
- a checkpoint after each complete physical line;
- the next byte offset and physical line number;
- the next parser context;
- any incomplete trailing bytes that must wait for the next append.

Codex JSONL parser context includes the active session ID, working directory, model, independently classified tool type, and next physical line number. The line number advances for every newline-terminated physical line, including empty, irrelevant, and malformed lines, so source event IDs remain compatible with those produced by the current new-project parser. This allows a token-count record appended later to retain the context established earlier in the file. Codex Desktop remains `codex-desktop`; VS Code remains `codex-vscode-plugin`; CLI remains `codex-cli`; an unrecognized Codex origin remains `other`.

The VS Code log adapter retains its next physical line number and stable source-file identity. While a file remains active, both adapters keep a final line without a newline pending. When that file identity is rotated away from the active path, the adapter performs one final-tail check: a syntactically complete target record is processed, a complete non-target record is skipped, and an invalid tail is recorded as a sanitized malformed-record error. This prevents a valid final record from remaining pending forever without treating a concurrently written active line as complete.

For the same source record, the incremental parsers must preserve the source event ID produced by the current new-project parsers. Changing read strategy must not make already ingested history appear to be new data.

Reads operate on raw bytes. A committed offset is the first byte not yet read from the file. Bytes after the last complete newline are stored in state as a base64-encoded pending buffer, while the committed offset advances past those buffered bytes. The next read begins at the committed offset and prepends the pending buffer exactly once. UTF-8 decoding happens only after a complete physical line has been assembled, so a multibyte character split across reads cannot be corrupted or counted twice. Carriage return before newline is removed after byte framing.

The pending buffer is limited to 1 MiB. If a physical line exceeds that limit, the parser enters discard-until-newline mode, records only a content hash and sanitized error category, advances past the oversized record, and resumes at the next line.

## Cursor and rotation handling

The state format is versioned and stores one record per stable file identity, plus an index from the current canonical path to that identity:

- stable file identity and its current path;
- the original source identity used by the event ID algorithm;
- byte offset;
- next physical line number;
- observed size and modification time;
- parser context;
- incomplete trailing bytes and discard-until-newline state.

A file identity uses the platform device, inode, and creation marker when they are reliable. On platforms that cannot provide that tuple, the fallback signature combines the creation marker with a hash of the first complete physical line, captured once and never recomputed as the file grows. An empty file is tracked by path until its first complete line establishes the fallback identity. Ambiguous fallback matches are never guessed. State records are matched by identity before path, allowing a renamed or rotated file to retain its cursor, next line number, parser context, and original source identity. In particular, a VS Code log keeps the path hash originally used by the current event ID algorithm after it is renamed; it must not be replayed under a new path hash.

A path that now resolves to a different file identity is a replacement. The replacement starts at offset zero with empty parser context and a source identity derived from its current path. A file whose size becomes smaller while its identity remains the same is treated as in-place truncation and also restarts at offset zero. When a processed file disappears, its full parser context may be compacted, but a small tombstone containing its stable identity, fallback signature, original source identity, final offset, and final line number is retained for the lifetime of the Agent state. This prevents a historical file from being replayed if it later reappears under another path. If neither the primary identity nor the fallback signature can correlate a renamed file safely, the Agent reports an identity ambiguity and does not replay that file automatically.

State writes use a temporary file, file synchronization, atomic rename, and parent-directory synchronization where the platform supports it. Corrupt or unsupported state versions stop ingestion with an actionable error instead of silently rescanning all history.

## Queue and commit ordering

For each incremental read, the Agent performs these steps in order:

1. Read at most 4 MiB and parse no more than 500 events, stopping on a complete-line checkpoint.
2. Select the largest complete-line prefix whose serialized events keep the queue at or below 100 MiB.
3. Append those events to the durable queue.
4. Synchronize the queue to disk.
5. Atomically commit the checkpoint's cursor, line number, pending bytes, and parser context.
6. Attempt upload before continuing with the next source chunk.

Advancing the cursor before the queue is durable is forbidden because it can lose events after a crash. If a crash occurs after queue append but before cursor commit, the next run may parse the range again. Enqueue therefore deduplicates by the pair `(toolSlug, sourceEventId)`. The server's existing uniqueness constraint remains the final idempotency boundary.

Only the watcher mutates the queue, and all enqueue, upload, and compaction operations run under one in-process queue mutex. No source append occurs concurrently with an upload. Queue compaction writes the unacknowledged suffix to a temporary file, synchronizes it, atomically renames it over the queue, and synchronizes the parent directory where supported.

The watcher sends at most 500 queued events in one request. A batch is fully acknowledged only when a successful response has the expected schema, `inserted + duplicates + rejected.length` equals the sent count, every rejected source event ID belongs to that batch exactly once, and no response entry is unaccounted for. Accepted and duplicate records may then be removed. Rejected records are first written durably to a mode-`0600` dead-letter file as the sanitized event, source event ID, and sanitized server reason before they are removed from the active queue. Dead-letter entries deduplicate by source event ID so a crash between dead-letter synchronization and queue compaction is harmless. An invalid, incomplete, or unaccounted response retains the entire batch and is treated as a protocol error.

## Upload retry behavior

New events trigger an immediate upload attempt. Network errors, non-success responses, and temporary server failures retain the queue and schedule exponential backoff starting at 30 seconds and capped at 30 minutes. A successful upload resets the backoff.

Source processing continues in bounded chunks while the server is unavailable until the queue reaches 100 MiB. The Agent never commits a line checkpoint whose serialized events would cross that limit. Reaching the limit stops advancing source cursors and emits a clear error so disk usage cannot grow without bound. The next successful upload resumes source processing.

Authentication failures are not treated as transient. The watcher keeps the queue, reports the failure, and retries no more than once every 30 minutes so a corrected configuration can recover without a process restart.

## Record and read error handling

The incremental parser classifies failures before deciding whether to advance a checkpoint:

- An incomplete final physical line remains in the pending buffer and is not parsed.
- A complete non-target record advances the line number and cursor without producing an event.
- A complete malformed target record records a content hash, line number, and sanitized error category, then advances past that record so one bad line cannot wedge the watcher.
- Temporary file errors such as a concurrent replacement, sharing violation, or transient permission error do not advance the cursor and are retried after re-stating the file.
- An unexpected parser invariant failure does not advance the cursor. It fails the processing cycle so systemd or the Windows task supervisor can restart the watcher and preserve evidence for diagnosis.

Raw source lines, prompts, paths, and malformed payload contents are never written to logs or the dead-letter file.

## Configuration and compatibility boundary

The only supported configuration directory is the Codex Usage Dashboard Agent directory. The obsolete `scanInterval` field is removed. Supported configured source keys remain the new Codex-only keys.

No client-side migration from the legacy project's configuration directory, queue, state, commands, service names, or source aliases is provided. Existing server-side acceptance of the currently deployed device credential is independent of the Agent execution-mode change and remains in place so the production device is not unnecessarily re-enrolled.

The currently deployed new-project Agent uses the supported configuration directory but has an unversioned fingerprint-only state. The installer archives that state before creating the versioned cursor state. Because the old state cannot supply safe byte offsets and parser context, the first watcher startup reconciles from offset zero in the bounded chunks defined above. Stable source event IDs and server uniqueness make this replay idempotent. The existing new-project upload queue is preserved and drained before new source ranges are processed.

## Installer and service cutover

The Linux installer writes one long-running `codex-usage-dashboard-agent.service` whose command is `watch`. Before stopping any running unit it:

1. Builds the new Agent and validates its configuration and executable.
2. Writes and verifies the replacement unit in a staging path.
3. Backs up the current units, configuration, queue, and state with mode `0600` where applicable.
4. Checks that the user systemd manager is available.
5. Checks systemd lingering. If lingering is disabled, installation stops before cutover with the exact enablement command unless the operator explicitly accepts session-only operation.

Only after those preflight steps pass does the installer stop and disable the obsolete units created by earlier new-project releases:

- `codex-usage-dashboard-agent.timer`;
- the one-shot scan version of `codex-usage-dashboard-agent.service`;
- `codex-usage-dashboard-agent-watch.service`.

It atomically installs the staged unit, reloads the user systemd manager, and enables the replacement service. The transition must not delete the queue. It archives the earlier new-project fingerprint state as described above and never treats that archive as active cursor state.

The installer waits up to 30 seconds for the new service to remain active, acquire its lock, validate state, and emit its startup health record. If any cutover step or health check fails, it stops the replacement, restores the previous units and state, reloads systemd, and restores the exact prior enabled and active states. Any queue or dead-letter output produced by the failed watcher is retained as a separate recovery artifact and is never overwritten by rollback.

The Windows installer validates and backs up the existing task definitions before replacement, installs one watcher-at-logon task with restart-on-failure settings, verifies that the watcher remains running, and restores the previous tasks if validation fails. It removes the scheduled scan task only after the replacement passes its health check. There is no hourly or daily scheduling option on either platform.

## Observability

Each processing cycle emits one structured record containing its reason (`startup`, `filesystem`, `reconciliation`, or `retry`), files advanced, events queued, events uploaded, queue depth, and next retry time. It must not log device tokens, source contents, prompts, absolute project paths, or raw metadata.

The `status` command reports watcher health from state without starting a scan: last successful source advance, last successful upload, last reconciliation, tracked file count, queue depth, and last error category.

## Verification strategy

Unit coverage must demonstrate:

- appended JSONL content advances a cursor and emits only new events;
- parser context survives across separate appends;
- line numbers and source event IDs match the current whole-file parsers;
- raw-byte framing handles UTF-8 splits and incomplete trailing lines;
- incomplete trailing records wait for completion;
- renamed files retain identity and do not receive new path-based event IDs;
- truncation and replacement reset only the affected cursor safely;
- ambiguous file identity does not trigger automatic replay;
- unknown Codex origins become `other` while Desktop remains independent;
- malformed complete records advance with sanitized diagnostics while temporary reads do not;
- initial history replay stays within the 4 MiB, 500-event, and 100 MiB limits;
- queue append precedes cursor commit;
- a simulated crash window cannot create an unbounded duplicate queue;
- partial, invalid, and rejected server acknowledgements cannot silently clear events;
- notification work and reconciliation are serialized;
- upload failures retain the queue and follow bounded backoff;
- a second watcher cannot acquire the state lock;
- installer output contains one watcher service and no timer;
- a failed service health check restores the prior unit states and preserves recovery queues.

An integration test uses temporary source logs and a local ingest endpoint. It starts the watcher, appends records across byte and UTF-8 boundaries, rotates a file, creates a new nested directory, injects malformed records, simulates partial acknowledgements and an upload outage, and verifies that every accepted event is eventually delivered without path-induced duplicates or queue growth from repeated whole-file parsing.

Deployment verification must confirm that the replacement service is active, both obsolete units are disabled or absent, the existing queue is empty or preserved, the earlier state archive exists, a newly appended real Codex record is uploaded, and the reconciliation timestamp is recorded. The six-hour interval is verified with a controlled clock in automated tests rather than waiting six hours during deployment. The production database count must only increase by genuinely new source event IDs.

## Rollout and rollback

The rollout builds and tests the new Agent, archives the fingerprint state, installs the replacement service without deleting the queue, and observes one real upload before considering the cutover complete. The existing hourly timer remains disabled after successful cutover.

Rollback restores the previous new-project Agent package and its hourly timer from the release artifact. It does not restore the legacy project Agent. Queue and state backups are taken before service replacement so rollback does not discard events collected while the server was unavailable.
