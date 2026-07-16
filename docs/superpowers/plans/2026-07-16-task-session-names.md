# Task and Session Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize current and historically recoverable Codex task/session names from workstation indexes and display them in the dashboard Tasks table.

**Architecture:** The Agent discovers and parses `session_index.jsonl`, compares its latest records with a dedicated local acknowledgement file, and sends changed task metadata to a new authenticated ingest endpoint. PostgreSQL stores title revisions independently from usage events; the admin task query left-joins that metadata so unnamed and fallback tasks retain their current behavior.

**Tech Stack:** Node.js 20.19+, TypeScript, Zod, Fastify, Drizzle ORM, PostgreSQL, React 19, Vitest, Testing Library.

## Global Constraints

- Name collection and upload are enabled by default with no opt-in flag.
- Agent startup synchronizes every recoverable historical name.
- `session_index.jsonl` is the only task-name source; do not read Codex internal SQLite databases.
- Titles are trimmed, non-empty, and limited to 500 characters.
- Ingest batches contain at most 1,000 task records.
- Only a strictly newer `updatedAt` revision may replace a stored title; equal timestamps are stale.
- Missing names and fallback tasks continue to display task IDs.
- Existing event ingest, task aggregation, filtering, sorting, and pagination remain backward compatible.
- Never print task titles in Agent status, cycle logs, error categories, or rejected-record reasons.
- Preserve the user's existing uncommitted changes in `README.md`, `apps/server-web/src/components/DataExplorer.tsx`, and `apps/server-web/src/components/DataExplorer.test.tsx`; stage only task-specific files for each commit.

## File Structure

- `packages/shared/src/schemas.ts`: owns task metadata request-item, envelope, acknowledgement, and exported TypeScript types.
- `packages/shared/src/schemas.test.ts`: proves title limits, timestamps, and batch-size boundaries.
- `apps/server/src/db/migrations/0004_task_metadata.sql`: creates the additive metadata table.
- `apps/server/src/db/schema.ts`: declares `taskMetadata` and its device relation.
- `apps/server/src/ingest/task-metadata.ts`: validates individual records, authenticates the device, and applies revision-aware inserts/updates.
- `apps/server/src/ingest/task-metadata.test.ts`: unit-tests partial rejection and revision outcomes.
- `apps/server/src/ingest/task-metadata.persistence.integration.test.ts`: proves PostgreSQL insert/update/stale behavior.
- `apps/server/src/ingest/routes.ts`: exposes `POST /api/ingest/tasks` using existing bearer-token hash fallback.
- `apps/agent/src/task-metadata-index.ts`: discovers index paths and parses/deduplicates index records.
- `apps/agent/src/task-metadata-index.test.ts`: covers path discovery and JSONL edge cases.
- `apps/agent/src/task-metadata-state.ts`: atomically persists server-acknowledged title revisions separately from usage cursors.
- `apps/agent/src/task-metadata-state.test.ts`: covers absent, valid, and invalid local state.
- `apps/agent/src/task-metadata-sync.ts`: computes changes, uploads batches, validates acknowledgement, and checkpoints accepted revisions.
- `apps/agent/src/task-metadata-sync.test.ts`: covers history sync, incremental changes, partial rejection, and retry safety.
- `apps/agent/src/watcher.ts`: invokes name sync in serialized cycles and watches discovered index directories.
- `apps/agent/src/cli.ts`: adds non-sensitive task-name counts to status output.
- `apps/server/src/admin/queries.ts`: left-joins task names into task aggregate rows.
- `apps/server-web/src/api.ts`: exposes nullable `taskName` to the UI.
- `apps/server-web/src/components/TasksTable.tsx`: renders name first and ID second.
- `apps/server-web/src/styles.css`: styles the two-line task identity without changing table behavior.
- `README.md` and `SECURITY.md`: disclose task/session name upload and its privacy implications.

---

### Task 1: Shared Task Metadata Contract

**Files:**
- Modify: `packages/shared/src/schemas.ts:24`
- Modify: `packages/shared/src/schemas.test.ts:1`

**Interfaces:**
- Produces: `taskMetadataDraftSchema`, `taskMetadataBatchEnvelopeSchema`, `taskMetadataAcknowledgementSchema`, `TaskMetadataDraft`, `TaskMetadataBatchEnvelope`, and `TaskMetadataAcknowledgement`.
- Consumes: Zod and the repository's existing shared-package export convention.

- [ ] **Step 1: Write failing schema tests**

Add tests that exercise the exact accepted and rejected boundaries:

```ts
import {
  taskMetadataAcknowledgementSchema,
  taskMetadataBatchEnvelopeSchema,
  taskMetadataDraftSchema
} from "./schemas.js";

it("accepts one task metadata revision and trims its title", () => {
  expect(taskMetadataDraftSchema.parse({
    taskId: "task-1",
    title: "  Dashboard work  ",
    updatedAt: "2026-07-16T00:00:00.000Z"
  })).toEqual({
    taskId: "task-1",
    title: "Dashboard work",
    updatedAt: "2026-07-16T00:00:00.000Z"
  });
});

it("rejects empty, over-length, and invalid-time task metadata", () => {
  expect(taskMetadataDraftSchema.safeParse({ taskId: "task-1", title: " ", updatedAt: "2026-07-16T00:00:00.000Z" }).success).toBe(false);
  expect(taskMetadataDraftSchema.safeParse({ taskId: "task-1", title: "x".repeat(501), updatedAt: "2026-07-16T00:00:00.000Z" }).success).toBe(false);
  expect(taskMetadataDraftSchema.safeParse({ taskId: "task-1", title: "Name", updatedAt: "not-a-time" }).success).toBe(false);
});

it("limits task metadata envelopes to 1000 raw records", () => {
  expect(taskMetadataBatchEnvelopeSchema.safeParse({ tasks: Array.from({ length: 1000 }, () => ({})) }).success).toBe(true);
  expect(taskMetadataBatchEnvelopeSchema.safeParse({ tasks: Array.from({ length: 1001 }, () => ({})) }).success).toBe(false);
});

it("validates task metadata acknowledgements without title content", () => {
  expect(taskMetadataAcknowledgementSchema.parse({
    inserted: 1,
    updated: 2,
    stale: 3,
    rejected: [{ taskId: "task-bad", reason: "invalid task metadata" }]
  })).toEqual({ inserted: 1, updated: 2, stale: 3, rejected: [{ taskId: "task-bad", reason: "invalid task metadata" }] });
});
```

- [ ] **Step 2: Run the shared tests and verify failure**

Run: `npm --workspace @codex-usage-dashboard/shared test -- --run src/schemas.test.ts`

Expected: FAIL because the task metadata schemas are not exported.

- [ ] **Step 3: Add the shared schemas and inferred types**

Add these declarations after `usageEventDraftSchema`:

```ts
export const taskMetadataDraftSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().trim().min(1).max(500),
  updatedAt: z.string().datetime()
});

export const taskMetadataBatchEnvelopeSchema = z.object({
  tasks: z.array(z.unknown()).max(1000)
});

export const taskMetadataAcknowledgementSchema = z.object({
  inserted: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  rejected: z.array(z.object({
    taskId: z.string(),
    reason: z.string().min(1)
  }))
});

export type TaskMetadataDraft = z.infer<typeof taskMetadataDraftSchema>;
export type TaskMetadataBatchEnvelope = z.infer<typeof taskMetadataBatchEnvelopeSchema>;
export type TaskMetadataAcknowledgement = z.infer<typeof taskMetadataAcknowledgementSchema>;
```

- [ ] **Step 4: Run shared tests and typecheck**

Run: `npm --workspace @codex-usage-dashboard/shared test -- --run src/schemas.test.ts && npm --workspace @codex-usage-dashboard/shared run typecheck`

Expected: all schema tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit the shared contract**

```powershell
git add -- packages/shared/src/schemas.ts packages/shared/src/schemas.test.ts
git commit -m "feat(shared): add task metadata contract"
```

### Task 2: PostgreSQL Task Metadata Schema

**Files:**
- Create: `apps/server/src/db/migrations/0004_task_metadata.sql`
- Modify: `apps/server/src/db/schema.ts:16`
- Modify: `apps/server/src/db/schema.test.ts:1`

**Interfaces:**
- Consumes: existing `devices.id` UUID primary key.
- Produces: Drizzle table `taskMetadata` with columns `taskId`, `title`, `sourceUpdatedAt`, `deviceId`, `createdAt`, and `updatedAt`.

- [ ] **Step 1: Extend schema tests with the expected migration and columns**

Add `taskMetadata` to the schema imports, assert its mapped names, and update the ordered migration list:

```ts
expect(taskMetadata.taskId.name).toBe("task_id");
expect(taskMetadata.title.notNull).toBe(true);
expect(taskMetadata.sourceUpdatedAt.name).toBe("source_updated_at");
expect(taskMetadata.deviceId.name).toBe("device_id");

expect(migrationFiles).toEqual([
  "0001_initial.sql",
  "0002_bigint_usage_counters.sql",
  "0003_usage_event_task_ids.sql",
  "0004_task_metadata.sql"
]);
```

Read `0004_task_metadata.sql` in the test and assert it contains `CREATE TABLE "task_metadata"`, `PRIMARY KEY ("task_id")`, and a foreign key to `devices`.

- [ ] **Step 2: Run the database schema test and verify failure**

Run: `npm --workspace @codex-usage-dashboard/server test -- --run src/db/schema.test.ts`

Expected: FAIL because `taskMetadata` and migration `0004` do not exist.

- [ ] **Step 3: Add the migration**

Create the migration with this additive schema:

```sql
CREATE TABLE "task_metadata" (
  "task_id" text PRIMARY KEY,
  "title" text NOT NULL,
  "source_updated_at" timestamp with time zone NOT NULL,
  "device_id" uuid NOT NULL REFERENCES "devices" ("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
```

- [ ] **Step 4: Declare the Drizzle table and relation**

Add:

```ts
export const taskMetadata = pgTable("task_metadata", {
  taskId: text("task_id").primaryKey(),
  title: text("title").notNull(),
  sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }).notNull(),
  deviceId: uuid("device_id").references(() => devices.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});
```

Extend `deviceRelations` with `taskMetadata: many(taskMetadata)` and add a `taskMetadataRelations` device relation using `taskMetadata.deviceId`.

- [ ] **Step 5: Run schema tests and server typecheck**

Run: `npm --workspace @codex-usage-dashboard/server test -- --run src/db/schema.test.ts && npm --workspace @codex-usage-dashboard/server run typecheck`

Expected: tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit the additive schema**

```powershell
git add -- apps/server/src/db/migrations/0004_task_metadata.sql apps/server/src/db/schema.ts apps/server/src/db/schema.test.ts
git commit -m "feat(server): store task metadata"
```

### Task 3: Authenticated Task Metadata Ingest

**Files:**
- Create: `apps/server/src/ingest/task-metadata.ts`
- Create: `apps/server/src/ingest/task-metadata.test.ts`
- Create: `apps/server/src/ingest/task-metadata.persistence.integration.test.ts`
- Modify: `apps/server/src/ingest/routes.ts:1`
- Modify: `apps/server/src/ingest/routes.test.ts:1`

**Interfaces:**
- Consumes: `TaskMetadataDraft`, `taskMetadataDraftSchema`, `taskMetadataBatchEnvelopeSchema`, `taskMetadata`, `requireDeviceByTokenHash`.
- Produces: `TaskMetadataIngestResult`, `TaskMetadataStore`, `ingestTaskMetadata`, `ingestValidatedTaskMetadata`, and `POST /api/ingest/tasks`.

- [ ] **Step 1: Write service tests for mixed validity and revision results**

Use an in-memory `TaskMetadataStore` whose `writeRevision` returns deterministic outcomes:

```ts
it("accepts valid records and rejects invalid records independently", async () => {
  const writes: TaskMetadataDraft[] = [];
  const result = await ingestValidatedTaskMetadata({
    tokenHash: "token-hash",
    rawTasks: [
      { taskId: "new", title: " New name ", updatedAt: "2026-07-16T00:00:00.000Z" },
      { taskId: "", title: "Bad", updatedAt: "not-a-time" },
      { taskId: "old", title: "Old name", updatedAt: "2026-07-15T00:00:00.000Z" }
    ],
    store: {
      requireDevice: async () => ({ id: "device-1" }),
      writeRevision: async (_deviceId, task) => {
        writes.push(task);
        return task.taskId === "new" ? "inserted" : "stale";
      }
    }
  });

  expect(writes.map(({ taskId, title }) => ({ taskId, title }))).toEqual([
    { taskId: "new", title: "New name" },
    { taskId: "old", title: "Old name" }
  ]);
  expect(result).toEqual({
    inserted: 1,
    updated: 0,
    stale: 1,
    rejected: [{ taskId: "", reason: "invalid task metadata" }]
  });
});
```

Add a second test that returns `"updated"` and proves the counter. Assert no rejection reason contains a title.

- [ ] **Step 2: Run the service test and verify failure**

Run: `npm --workspace @codex-usage-dashboard/server test -- --run src/ingest/task-metadata.test.ts`

Expected: FAIL because the task metadata ingest module does not exist.

- [ ] **Step 3: Implement validation and store boundaries**

Define:

```ts
export type TaskMetadataWriteOutcome = "inserted" | "updated" | "stale";

export type TaskMetadataStore = {
  requireDevice(tokenHash: string): Promise<{ id: string }>;
  writeRevision(deviceId: string, task: TaskMetadataDraft): Promise<TaskMetadataWriteOutcome>;
};

export type TaskMetadataIngestResult = TaskMetadataAcknowledgement;
```

`ingestValidatedTaskMetadata` authenticates once, parses each raw record with `taskMetadataDraftSchema.safeParse`, uses the raw string `taskId` or `""` in rejection entries, calls `writeRevision` for valid records, and increments exactly one counter per valid item.

`createDrizzleTaskMetadataStore` first inserts with `onConflictDoNothing().returning({ taskId })`; if nothing was inserted, it updates only where both `taskId` matches and `sourceUpdatedAt` is strictly less than `new Date(task.updatedAt)`. A missing update return is stale.

- [ ] **Step 4: Write route tests before exposing the endpoint**

Add `postTasks` using a new injectable `ingestTasks` handler and assert:

```ts
expect((await postTasks(validTaskPayload, null)).statusCode).toBe(401);
expect((await postTasks({ tasks: Array.from({ length: 1001 }, () => ({})) })).statusCode).toBe(400);
expect((await postTasks(validTaskPayload)).json()).toEqual({ inserted: 1, updated: 0, stale: 0, rejected: [] });
```

Also reuse the existing legacy bearer-hash test pattern and prove a `DeviceAuthError` becomes 401.

- [ ] **Step 5: Add `POST /api/ingest/tasks`**

Extend route options:

```ts
export type IngestTasksHandler = (input: { tokenHash: string; batch: unknown }) => Promise<TaskMetadataIngestResult>;

export type RegisterIngestRoutesOptions = {
  ingestEvents?: IngestEventsHandler;
  ingestTasks?: IngestTasksHandler;
};
```

The route validates only the envelope with `taskMetadataBatchEnvelopeSchema`, logs `{ taskCount }`, attempts both current and legacy token hashes, and returns the service result. It uses `invalid task metadata batch` for envelope failures and never logs the body.

- [ ] **Step 6: Add PostgreSQL integration coverage**

Insert one test device, then send revisions at `00:00`, `01:00`, `00:30`, and `01:00` with different titles. Assert the outcomes are `inserted`, `updated`, `stale`, and `stale`, and query `taskMetadata` to verify the `01:00` title and source timestamp remain stored. Delete the metadata row and device in test cleanup.

- [ ] **Step 7: Run ingest tests and server typecheck**

Run: `npm --workspace @codex-usage-dashboard/server test -- --run src/ingest/task-metadata.test.ts src/ingest/routes.test.ts`

If `TEST_DATABASE_URL` is configured, also run: `npm --workspace @codex-usage-dashboard/server test -- --run src/ingest/task-metadata.persistence.integration.test.ts`

Then run: `npm --workspace @codex-usage-dashboard/server run typecheck`

Expected: unit and route tests pass; the integration test either passes with PostgreSQL or follows the repository's existing explicit skip convention when no test database is configured; TypeScript exits 0.

- [ ] **Step 8: Commit task metadata ingestion**

```powershell
git add -- apps/server/src/ingest/task-metadata.ts apps/server/src/ingest/task-metadata.test.ts apps/server/src/ingest/task-metadata.persistence.integration.test.ts apps/server/src/ingest/routes.ts apps/server/src/ingest/routes.test.ts
git commit -m "feat(server): ingest task names"
```

### Task 4: Agent Index Discovery and Parsing

**Files:**
- Create: `apps/agent/src/task-metadata-index.ts`
- Create: `apps/agent/src/task-metadata-index.test.ts`

**Interfaces:**
- Produces: `discoverTaskIndexPaths`, `parseTaskMetadataIndex`, and `TaskMetadataIndexResult`.
- Consumes: `AgentConfig`, `TaskMetadataDraft`, Node filesystem/path/os APIs.

- [ ] **Step 1: Write path-discovery tests**

Create temporary roots with `sessions/` and `session_index.jsonl`. Assert this call returns a deduplicated resolved index path:

```ts
await expect(discoverTaskIndexPaths({
  config: { serverUrl: "https://example.test", deviceToken: "token", deviceName: "device", toolPaths: { "codex-cli": [sessionsDir] } },
  env: { CODEX_HOME: codexHome },
  homeDir
})).resolves.toEqual([path.resolve(codexHome, "session_index.jsonl")]);
```

Add separate cases for an ancestor of a configured session path, `CODEX_HOME`, the default `.codex`, missing files, and two distinct valid indexes.

- [ ] **Step 2: Write parser tests**

Write index content containing duplicate IDs, whitespace, invalid timestamps, an over-length title, malformed JSON, and an incomplete final line. Assert:

```ts
expect(result.tasks).toEqual([
  { taskId: "task-1", title: "Newest", updatedAt: "2026-07-16T01:00:00.000Z" }
]);
expect(result.rejected).toBe(3);
expect(result.deferredTail).toBe(true);
```

The earlier valid revision for `task-1` must be replaced by the later valid revision.

- [ ] **Step 3: Run the index tests and verify failure**

Run: `npm --workspace @codex-usage-dashboard/agent test -- --run src/task-metadata-index.test.ts`

Expected: FAIL because the index module does not exist.

- [ ] **Step 4: Implement index discovery**

Use this signature:

```ts
export async function discoverTaskIndexPaths(input: {
  config: AgentConfig;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<string[]>;
```

For each configured `codex-cli` root, test the root and each ancestor for `session_index.jsonl`, stopping at the first match for that root. Add `<CODEX_HOME>/session_index.jsonl` and `<homeDir>/.codex/session_index.jsonl`, retain only regular files, resolve absolute paths, deduplicate, and sort for deterministic tests.

- [ ] **Step 5: Implement safe index parsing**

Use:

```ts
export type TaskMetadataIndexResult = {
  tasks: TaskMetadataDraft[];
  rejected: number;
  deferredTail: boolean;
};

export async function parseTaskMetadataIndex(filePath: string): Promise<TaskMetadataIndexResult>;
```

Split while retaining whether the file ends in a newline. Parse newline-terminated records independently, map `id`, `thread_name`, and `updated_at` through `taskMetadataDraftSchema`, count invalid completed lines, defer an incomplete final line, and deduplicate valid tasks by the newest parsed timestamp. Equal timestamps keep the first valid record for deterministic behavior.

- [ ] **Step 6: Run index tests and Agent typecheck**

Run: `npm --workspace @codex-usage-dashboard/agent test -- --run src/task-metadata-index.test.ts && npm --workspace @codex-usage-dashboard/agent run typecheck`

Expected: all index tests pass and TypeScript exits 0.

- [ ] **Step 7: Commit index support**

```powershell
git add -- apps/agent/src/task-metadata-index.ts apps/agent/src/task-metadata-index.test.ts
git commit -m "feat(agent): read Codex task names"
```

### Task 5: Agent Task Metadata State and Synchronization

**Files:**
- Create: `apps/agent/src/task-metadata-state.ts`
- Create: `apps/agent/src/task-metadata-state.test.ts`
- Create: `apps/agent/src/task-metadata-sync.ts`
- Create: `apps/agent/src/task-metadata-sync.test.ts`

**Interfaces:**
- Consumes: `discoverTaskIndexPaths`, `parseTaskMetadataIndex`, `taskMetadataAcknowledgementSchema`, `AgentConfig`, and `atomicWriteFile`.
- Produces: `taskMetadataStatePath`, `readTaskMetadataState`, `writeTaskMetadataState`, `syncTaskMetadata`, and `TaskMetadataSyncResult`.

- [ ] **Step 1: Write dedicated state tests**

Assert a missing file returns an empty version-1 state, a valid file round-trips with mode `0600` through the existing atomic writer, and another version throws:

```ts
expect(await readTaskMetadataState(statePath)).toEqual({ version: 1, acknowledged: {} });
await writeTaskMetadataState({ version: 1, acknowledged: { "task-1": { title: "Name", updatedAt: "2026-07-16T00:00:00.000Z" } } }, statePath);
expect(await readTaskMetadataState(statePath)).toEqual({ version: 1, acknowledged: { "task-1": { title: "Name", updatedAt: "2026-07-16T00:00:00.000Z" } } });
```

- [ ] **Step 2: Implement focused state persistence**

Define:

```ts
export type TaskMetadataStateV1 = {
  version: 1;
  acknowledged: Record<string, { title: string; updatedAt: string }>;
};

export function taskMetadataStatePath(agentStatePath: string): string {
  return path.join(path.dirname(agentStatePath), "task-metadata-state.json");
}
```

Use `atomicWriteFile(..., 0o600)`. Reject unsupported versions exactly as the usage-state reader does.

- [ ] **Step 3: Write synchronization tests before implementation**

Create a real temporary index and inject `fetchImpl`. Cover:

1. startup sends all names in one request and persists them;
2. a second unchanged sync makes no request;
3. a newer revision sends only that task;
4. a 500 response leaves acknowledgement state unchanged;
5. a 200 response with one rejected `taskId` checkpoints all non-rejected tasks only;
6. 1,001 changed tasks produce request batch sizes `[1000, 1]`;
7. request bodies and returned results contain counts but tests never rely on logging titles.

Use this expected result shape:

```ts
expect(result).toEqual({
  discovered: 2,
  submitted: 2,
  acknowledged: 1,
  rejected: 1,
  malformed: 0,
  attempted: true,
  status: 200,
  errorCategory: null
});
```

- [ ] **Step 4: Run sync tests and verify failure**

Run: `npm --workspace @codex-usage-dashboard/agent test -- --run src/task-metadata-state.test.ts src/task-metadata-sync.test.ts`

Expected: FAIL because state and synchronization modules do not exist.

- [ ] **Step 5: Implement synchronization and acknowledgement validation**

Use:

```ts
export type TaskMetadataSyncResult = {
  discovered: number;
  submitted: number;
  acknowledged: number;
  rejected: number;
  malformed: number;
  attempted: boolean;
  status: number | null;
  errorCategory: string | null;
};

export async function syncTaskMetadata(input: {
  config: AgentConfig;
  agentStatePath: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<TaskMetadataSyncResult>;
```

Merge parsed indexes by task ID and newest timestamp. A task is changed when no acknowledgement exists, its `updatedAt` is later, or the same revision has a different title. Send `{ tasks: batch }` to `/api/ingest/tasks` with the existing bearer token. Parse successful bodies with `taskMetadataAcknowledgementSchema`; a malformed success body returns `errorCategory: "task-metadata-ack-invalid"` and checkpoints nothing. HTTP failure returns `errorCategory: "task-metadata-upload-http-failed"`; thrown fetch errors return `"task-metadata-upload-failed"`. For a valid acknowledgement, checkpoint every submitted task whose ID is absent from `rejected`.

- [ ] **Step 6: Run sync tests and Agent typecheck**

Run: `npm --workspace @codex-usage-dashboard/agent test -- --run src/task-metadata-state.test.ts src/task-metadata-sync.test.ts && npm --workspace @codex-usage-dashboard/agent run typecheck`

Expected: all state and synchronization tests pass and TypeScript exits 0.

- [ ] **Step 7: Commit Agent synchronization**

```powershell
git add -- apps/agent/src/task-metadata-state.ts apps/agent/src/task-metadata-state.test.ts apps/agent/src/task-metadata-sync.ts apps/agent/src/task-metadata-sync.test.ts
git commit -m "feat(agent): synchronize task names"
```

### Task 6: Integrate Name Synchronization with the Watcher

**Files:**
- Modify: `apps/agent/src/watcher.ts:18`
- Modify: `apps/agent/src/watcher.test.ts:1`
- Modify: `apps/agent/src/watcher.integration.test.ts:1`
- Modify: `apps/agent/src/cli.ts:77`
- Modify: `apps/agent/src/cli.test.ts:1`
- Modify: `apps/agent/src/state.ts:30`
- Modify: `apps/agent/src/state.test.ts:1`

**Interfaces:**
- Consumes: `syncTaskMetadata`, `discoverTaskIndexPaths`.
- Produces: watcher cycle fields `taskNamesDiscovered`, `taskNamesSubmitted`, `taskNamesAcknowledged`, `taskNamesRejected`, and matching non-sensitive status fields.

- [ ] **Step 1: Write watcher and status tests**

Extend the watcher integration fixture with `session_index.jsonl` and branch injected fetch behavior by URL pathname. Assert startup posts usage events and task metadata, then returns:

```ts
expect(result).toMatchObject({
  eventsUploaded: 1,
  taskNamesDiscovered: 1,
  taskNamesSubmitted: 1,
  taskNamesAcknowledged: 1,
  taskNamesRejected: 0
});
```

Add a 500 task-metadata response test that expects `errorCategory: "task-metadata-upload-http-failed"` and proves a later `retry` cycle resubmits the name. Extend `readAgentStatus` expectations with the latest persisted name-sync counts and error category, never title values.

- [ ] **Step 2: Run watcher tests and verify failure**

Run: `npm --workspace @codex-usage-dashboard/agent test -- --run src/watcher.test.ts src/watcher.integration.test.ts src/cli.test.ts`

Expected: FAIL because watcher results and status lack task-name fields.

- [ ] **Step 3: Add index directories to watch roots**

Change `resolveExistingWatchRoots` to union existing source roots with `path.dirname(indexPath)` for every discovered task index. Keep deterministic deduplication. Allow tests to inject `env` and `homeDir` through an optional second argument while production uses `process.env` and `os.homedir()`.

- [ ] **Step 4: Run name sync inside serialized watcher cycles**

After usage ingestion and before final state reporting, call `syncTaskMetadata` when uploads are retry-eligible. Combine its attempt, HTTP status, and error category with the existing retry decision: any event or task-metadata upload failure schedules retry; a successful cycle resets backoff only when both channels succeeded or had nothing to send.

Extend `WatcherCycleResult` and `runWatcherCycle` return values with numeric name counts. Persist only those counts and the last successful task-name upload time in the existing Agent state using optional fields so version-2 state files remain readable without migration.

- [ ] **Step 5: Extend non-sensitive CLI status**

Return:

```ts
taskNamesDiscovered: number;
taskNamesAcknowledged: number;
lastTaskMetadataUploadAt: string | null;
```

Hydrate absent optional values to `0`, `0`, and `null`. Do not include names or task IDs.

- [ ] **Step 6: Run Agent tests and typecheck**

Run: `npm --workspace @codex-usage-dashboard/agent test -- --run src/watcher.test.ts src/watcher.integration.test.ts src/cli.test.ts && npm --workspace @codex-usage-dashboard/agent run typecheck`

Expected: all selected tests pass and TypeScript exits 0.

- [ ] **Step 7: Commit watcher integration**

```powershell
git add -- apps/agent/src/watcher.ts apps/agent/src/watcher.test.ts apps/agent/src/watcher.integration.test.ts apps/agent/src/cli.ts apps/agent/src/cli.test.ts apps/agent/src/state.ts apps/agent/src/state.test.ts
git commit -m "feat(agent): watch task name updates"
```

### Task 7: Return and Render Task Names

**Files:**
- Modify: `apps/server/src/admin/queries.ts:1`
- Modify: `apps/server/src/admin/queries.test.ts:140`
- Modify: `apps/server/src/admin/queries.integration.test.ts:300`
- Modify: `apps/server-web/src/api.ts:51`
- Modify: `apps/server-web/src/components/TasksTable.tsx:63`
- Modify: `apps/server-web/src/components/TasksTable.test.tsx:6`
- Modify: `apps/server-web/src/styles.css`
- Modify: `apps/server-web/src/styles.test.ts`

**Interfaces:**
- Consumes: `taskMetadata.taskId`, existing task aggregate subquery, and `TaskUsage`.
- Produces: `taskName: string | null` on each admin task row and named-task visual presentation.

- [ ] **Step 1: Write failing server query tests**

Import `taskMetadata`, add it to the task-row query selection, and assert generated SQL contains a left join on task ID. In the integration test, insert metadata for one real task and assert:

```ts
expect(result.rows.find((row) => row.taskId === namedTask)).toMatchObject({ taskName: "Named task" });
expect(result.rows.find((row) => row.taskId === unnamedTask)).toMatchObject({ taskName: null });
```

Retain existing pagination, sort, and stable tie assertions unchanged.

- [ ] **Step 2: Run task query tests and verify failure**

Run: `npm --workspace @codex-usage-dashboard/server test -- --run src/admin/queries.test.ts`

Expected: FAIL because task metadata is not joined or selected.

- [ ] **Step 3: Left-join task metadata after aggregation**

Import `taskMetadata`, extend `TaskAggregateRow` with `taskName: string | null`, select `taskName: taskMetadata.title`, and add:

```ts
.leftJoin(taskMetadata, eq(taskMetadata.taskId, taskGroups.taskId))
```

Place the metadata join after `taskGroups`; do not join it inside the grouped usage query. Extend `normalizeTaskRow` to return `taskName: row.taskName ?? null` without changing any numeric normalization.

- [ ] **Step 4: Write failing Tasks table tests**

Add `taskName` to every fixture. Assert a named task renders `Named task` before a visible full task ID, an unnamed task renders only its ID, and a fallback task ignores a supplied null name and keeps the badge. Assert the task cell title remains the full task ID.

- [ ] **Step 5: Update API type, component markup, and focused CSS**

Add `taskName: string | null` to `TaskUsage`. Render:

```tsx
<td title={row.taskId}>
  {row.isFallback ? <span className="status fallback">{t("Fallback")}</span> : null}
  {row.taskName && !row.isFallback ? (
    <span className="task-identity">
      <span className="task-name">{row.taskName}</span>
      <span className="task-id mono">{row.taskId}</span>
    </span>
  ) : (
    <span className="mono">{row.taskId}</span>
  )}
</td>
```

Add CSS that uses a vertical inline-flex identity, normal font for `.task-name`, monospace subdued text for `.task-id`, wrapping for long names, and no fixed width that would break the existing horizontal table overflow. Extend `styles.test.ts` to assert the new selectors and wrapping rule.

- [ ] **Step 6: Run server and web task tests**

Run: `npm --workspace @codex-usage-dashboard/server test -- --run src/admin/queries.test.ts && npm --workspace @codex-usage-dashboard/server-web test -- --run src/components/TasksTable.test.tsx src/styles.test.ts`

If `TEST_DATABASE_URL` is configured, also run: `npm --workspace @codex-usage-dashboard/server test -- --run src/admin/queries.integration.test.ts`

Expected: selected tests pass and existing task behavior assertions remain green.

- [ ] **Step 7: Run server and web typechecks**

Run: `npm --workspace @codex-usage-dashboard/server run typecheck && npm --workspace @codex-usage-dashboard/server-web run typecheck`

Expected: TypeScript exits 0 for both workspaces.

- [ ] **Step 8: Commit query and UI support**

```powershell
git add -- apps/server/src/admin/queries.ts apps/server/src/admin/queries.test.ts apps/server/src/admin/queries.integration.test.ts apps/server-web/src/api.ts apps/server-web/src/components/TasksTable.tsx apps/server-web/src/components/TasksTable.test.tsx apps/server-web/src/styles.css apps/server-web/src/styles.test.ts
git commit -m "feat(web): display task names"
```

### Task 8: Privacy Documentation and Full Verification

**Files:**
- Modify: `README.md:114`
- Modify: `SECURITY.md`

**Interfaces:**
- Consumes: final implemented behavior.
- Produces: accurate public disclosure and repository-wide verification evidence.

- [ ] **Step 1: Update privacy disclosure without overwriting current README work**

Inspect `git diff -- README.md` first. Apply a narrow patch to the privacy paragraph so it states that the Agent uploads task/session names as well as token counts, timestamps, models, source types, task IDs, and cryptographic hashes. Remove the old claim that session titles are not uploaded. Keep the claims that prompts, responses, and full local paths are not uploaded.

Add a `Data collected by the Agent` section to `SECURITY.md` stating that task/session names may contain user-authored content, deployments must protect dashboard and database access accordingly, and the Agent never uploads full prompts or responses.

- [ ] **Step 2: Run focused privacy and open-source checks**

Run: `rg -n "session titles|task/session names|prompts|responses" README.md SECURITY.md`

Expected: no stale statement says session titles are excluded, while prompts and responses remain explicitly excluded.

Run: `npm run check:open-source`

Expected: exits 0 with no private path, credential, or source-content finding.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`

Expected: every workspace test passes. Database integration tests follow the existing environment-gated behavior when `TEST_DATABASE_URL` is absent.

- [ ] **Step 4: Run full typechecking**

Run: `npm run typecheck`

Expected: all four workspaces exit 0.

- [ ] **Step 5: Build all production artifacts**

Run: `npm run build`

Expected: shared, Agent, server, and server-web builds complete; server build copies migration `0004_task_metadata.sql` into its distribution.

- [ ] **Step 6: Inspect final scope and migration package**

Run:

```powershell
git status --short
git diff --check
Get-Item apps/server/dist/db/migrations/0004_task_metadata.sql
```

Expected: only intended task-name changes plus the user's preserved pre-existing modifications are present; `git diff --check` is empty; the built migration exists.

- [ ] **Step 7: Commit documentation only**

The live pre-plan check found no content diff in `README.md` despite its worktree status. Stage the two documentation files only after verifying the resulting README diff contains exactly the privacy paragraph:

```powershell
git diff -- README.md SECURITY.md
git add -- SECURITY.md
git diff -U0 -- README.md
git add -- README.md
git diff --cached -- README.md SECURITY.md
git commit -m "docs: disclose task name collection"
```

Expected before commit: the cached README diff contains only the privacy paragraph and the cached SECURITY diff contains only the new data-collection section. If either file has unrelated content, stop before committing and preserve it unstaged.

- [ ] **Step 8: Record final verification**

Run: `git log -8 --oneline --decorate && git status --short`

Expected: the task's focused commits are visible in order; remaining changes are only user-owned changes that were intentionally not included in task commits.
