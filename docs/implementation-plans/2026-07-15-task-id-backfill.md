# Task ID Collection and Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a task ID for every usage event, recover real task IDs by replaying local Codex session logs, and retain one fallback task per device for events that cannot be recovered.

**Architecture:** The shared ingest event gains an optional `taskId`; current and legacy Codex parsers populate it from session metadata. The server converts missing IDs into a deterministic device fallback and enriches only fallback-valued duplicate rows during replay. A one-shot Agent command streams configured Codex JSONL files from the beginning in bounded batches without touching watcher state.

**Tech Stack:** TypeScript, Zod, Fastify ingest service, Drizzle ORM, PostgreSQL migrations, Commander, Vitest.

## Global Constraints

- Each device has exactly one deterministic fallback task ID; fallback tasks are never shared across devices.
- Old Agents that omit `taskId` remain accepted.
- Duplicate replay may replace fallback with a real task ID, but may not overwrite another real task ID or usage metrics.
- Backfill does not read or print prompts, responses, or raw task content.
- Backfill does not mutate watcher cursor, queue, or state files.
- No new files are added under `docs/superpowers`.

---

### Task 1: Shared protocol and Codex parser task identity

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/schemas.test.ts`
- Modify: `apps/agent/src/parsers/codex.ts`
- Modify: `apps/agent/src/parsers/parsers.test.ts`

**Interfaces:**
- Produces: `UsageEventDraft.taskId?: string | null`
- Produces: current session events use `session_meta.payload.id`; legacy events use `session_id`.

- [ ] **Step 1: Write failing schema and parser tests**

Add assertions equivalent to:

```ts
expect(usageEventDraftSchema.parse({ ...validEvent, taskId: "task-1" }).taskId).toBe("task-1");
expect(usageEventDraftSchema.parse(validEvent).taskId).toBeUndefined();
expect(currentEvents[0]?.taskId).toBe("session-1");
expect(legacyEvents[0]?.taskId).toBe("legacy-session-1");
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm --workspace @codex-usage-dashboard/shared test -- schemas.test.ts
npm --workspace @codex-usage-dashboard/agent test -- parsers.test.ts
```

Expected: failures because `taskId` is absent.

- [ ] **Step 3: Add the optional protocol field and parser mapping**

Add:

```ts
taskId: z.string().min(1).nullable().optional(),
```

Emit current events with `taskId: input.context.sessionId` and legacy events with `taskId: stableRecordId`.

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run the two commands from Step 2. Expected: both pass.

---

### Task 2: Database migration and device-scoped fallback enrichment

**Files:**
- Create: `apps/server/src/db/migrations/0003_usage_event_task_ids.sql`
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/db/schema.test.ts`
- Modify: `apps/server/src/ingest/service.ts`
- Modify: `apps/server/src/ingest/service.test.ts`
- Modify: `apps/server/src/ingest/persistence.integration.test.ts`

**Interfaces:**
- Produces: `fallbackTaskId(deviceId: string): string`
- Produces: `usage_events.task_id text NOT NULL`
- Produces: `IngestStore.enrichUsageEventTask(event): Promise<void>`

- [ ] **Step 1: Write failing migration and service tests**

Test these behaviors:

```ts
expect(fallbackTaskId("device-1")).toBe("fallback:device-1");
expect(fallbackTaskId("device-2")).not.toBe(fallbackTaskId("device-1"));
expect(persistedEvent.taskId).toBe("fallback:device-1");
expect(enrichedEvents).toEqual([{ sourceEventId: "duplicate-event", taskId: "task-real" }]);
```

Update schema tests to require migration `0003_usage_event_task_ids.sql`, `usageEvents.taskId.name === "task_id"`, and `notNull === true`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm --workspace @codex-usage-dashboard/server test -- schema.test.ts service.test.ts
```

Expected: failures for missing migration, schema field, fallback function, and enrichment port.

- [ ] **Step 3: Add migration and Drizzle mapping**

Migration content:

```sql
ALTER TABLE "usage_events" ADD COLUMN "task_id" text;
UPDATE "usage_events"
SET "task_id" = 'fallback:' || "device_id"::text
WHERE "task_id" IS NULL;
ALTER TABLE "usage_events" ALTER COLUMN "task_id" SET NOT NULL;
CREATE INDEX "usage_events_device_task_idx"
  ON "usage_events" ("device_id", "task_id");
```

Map `taskId: text("task_id").notNull()` in `usageEvents`.

- [ ] **Step 4: Add fallback assignment and duplicate enrichment**

Implement:

```ts
export function fallbackTaskId(deviceId: string): string {
  return `fallback:${deviceId}`;
}
```

Build persistable events with `taskId: event.taskId ?? fallbackTaskId(device.id)`. Keep `insertUsageEvent` as the insertion/idempotency decision. On duplicates call `enrichUsageEventTask`; its Drizzle implementation updates only the same `(deviceId, toolId, sourceEventId)` row whose stored task ID equals `fallbackTaskId(deviceId)`, setting the incoming non-fallback real ID. It never updates metrics.

- [ ] **Step 5: Verify targeted server tests GREEN**

Run the command from Step 2 plus the persistence integration test when `TEST_DATABASE_URL` is available.

---

### Task 3: One-shot local task-ID backfill command

**Files:**
- Create: `apps/agent/src/task-backfill.ts`
- Create: `apps/agent/src/task-backfill.test.ts`
- Modify: `apps/agent/src/cli.ts`
- Modify: `apps/agent/src/cli.test.ts`
- Modify: `apps/agent/src/processor.ts`

**Interfaces:**
- Produces: `backfillTaskIds(input): Promise<TaskBackfillResult>`
- Produces CLI: `codex-usage-dashboard-agent backfill-task-ids --confirm`
- Produces optional safety preview: `codex-usage-dashboard-agent backfill-task-ids --dry-run`

- [ ] **Step 1: Write failing scanner and CLI tests**

Use temporary JSONL files containing `session_meta`, `turn_context`, and token records. Assert:

```ts
expect(result).toMatchObject({ filesScanned: 1, eventsFound: 2, batchesSubmitted: 1 });
expect(uploaded.flatMap((batch) => batch.events).map((event) => event.taskId))
  .toEqual(["task-a", "task-a"]);
expect(await fs.readFile(statePath, "utf8")).toBe(originalState);
expect(createProgram().commands.map((command) => command.name()))
  .toContain("backfill-task-ids");
```

Also test 501 events produce two batches, malformed records are counted and skipped, `--confirm` is required for uploads, and dry-run performs no fetch.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm --workspace @codex-usage-dashboard/agent test -- task-backfill.test.ts cli.test.ts
```

Expected: failures because the module and command do not exist.

- [ ] **Step 3: Implement bounded replay without watcher state**

`task-backfill.ts` must:

1. Enumerate only configured `codex-cli` JSONL sources using the existing parser adapter discovery.
2. Stream each file line-by-line with a fresh `initialCodexContext()`.
3. Feed records through `parseCodexLine` with the original physical line number.
4. Count malformed records and continue.
5. Collect at most 500 events per ingest batch.
6. Use the same device envelope and authenticated `uploadIngestBatch` path as normal ingestion.
7. Require a complete acknowledgement before advancing to the next batch.
8. Return sanitized numeric counters only.

Export the existing ingest-envelope helper from `processor.ts` so watcher and backfill produce identical device metadata.

- [ ] **Step 4: Wire Commander safety options**

Add `backfill-task-ids` with mutually understood behavior:

- `--dry-run`: scan and report without network upload.
- `--confirm`: allow authenticated upload.
- neither: throw `backfill-task-ids requires --confirm or --dry-run`.

- [ ] **Step 5: Run targeted Agent tests and verify GREEN**

Run the command from Step 2. Expected: pass.

---

### Task 4: Documentation, full verification, and local replay

**Files:**
- Modify: `README.md`
- Modify: `docs/task-id-backfill-design.md` only if implementation details require correction.

**Interfaces:**
- Documents the migration-before-replay requirement and exact dry-run/upload commands.

- [ ] **Step 1: Document the operator flow**

Add:

```bash
npm run agent -- backfill-task-ids --dry-run
npm run agent -- backfill-task-ids --confirm
```

State that the server migration must be deployed first, the command does not reset watcher state, replay is idempotent, and unrecoverable records remain in the device fallback task.

- [ ] **Step 2: Run complete local verification**

Run:

```bash
npm test
npm run typecheck
npm run build
npm run check:open-source
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Run a local dry-run against configured logs**

Run:

```bash
npm run agent -- backfill-task-ids --dry-run
```

Expected: sanitized counts with no network mutation and no watcher state change.

- [ ] **Step 4: Gate the real historical upload**

Verify the target server has migration `0003_usage_event_task_ids.sql` and the duplicate enrichment code. Only then run:

```bash
npm run agent -- backfill-task-ids --confirm
```

If the target server has not been upgraded, stop after dry-run and report the exact deployment prerequisite rather than sending data.
