# Task Usage Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-aggregated, sortable, paginated Tasks tab to Usage details while preserving Events.

**Architecture:** `GET /api/admin/tasks` applies the shared event filters, groups by persisted `task_id`, sorts aggregate rows with a stable task-ID tie-breaker, and paginates after grouping. React requests tasks with the other dashboard datasets and renders a focused table with independent sort and page state.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM, PostgreSQL, React, Vitest, Testing Library, Vite

## Global Constraints

- Keep Events and place Tasks between Events and Devices.
- Apply date, time zone, tool, device, project, and model filters before aggregation.
- Never derive task totals from the paginated event response.
- Default to last activity descending; also sort by event count, total tokens, and cost in both directions.
- Sort before pagination and use task ID as the stable tie-breaker.
- Keep event and task sort/page state independent; global filters reset both offsets.
- Label `fallback:` IDs and preserve their device-scoped grouping.
- Translate `Multiple` for multi-device or multi-project tasks.
- Do not add expansion, drill-down, naming, or navigation.
- Add Chinese, Japanese, English, and Korean UI copy.
- Keep plans in `docs/implementation-plans`; do not add `docs/superpowers`.

---

### Task 1: Task Aggregate Query

**Files:**
- Modify: `apps/server/src/admin/queries.ts`
- Test: `apps/server/src/admin/queries.integration.test.ts`

**Interfaces:**
- Consumes: `UsageFilters`, `SortDir`, `eventWhere()`, `usageEvents`, `devices`, and `projects`.
- Produces: `TaskSortBy` and `AdminQueryService.getTasks(filters)` returning `{ rows, total }`.

- [ ] **Step 1: Write the failing PostgreSQL integration test**

Add a database-backed test with two `task-alpha` events and one fallback event. Use two devices and projects for `task-alpha`, then assert the complete group is aggregated before `limit: 1`:

```ts
const result = await service.getTasks({
  from: "2026-07-15", to: "2026-07-15", timeZone: "UTC", tool: tool.slug,
  model: "gpt-5", sortBy: "totalTokens", sortDir: "desc", limit: 1, offset: 0
});
expect(result.total).toBe(2);
expect(result.rows).toEqual([expect.objectContaining({
  taskId: `task-alpha-${unique}`, isFallback: false,
  startedAt: new Date("2026-07-15T10:00:00.000Z"),
  lastActivityAt: new Date("2026-07-15T11:00:00.000Z"),
  deviceId: null, deviceName: null, deviceCount: 2,
  projectId: null, projectName: null, projectCount: 2,
  eventCount: 2, inputTokens: 30, outputTokens: 6,
  cacheReadTokens: 9, cacheWriteTokens: 3, totalTokens: 48, costUsd: 0.3
})]);
const fallback = await service.getTasks({
  from: "2026-07-15", to: "2026-07-15", timeZone: "UTC",
  tool: tool.slug, deviceId: deviceA.id, model: "gpt-5",
  sortBy: "lastActivityAt", sortDir: "desc"
});
expect(fallback.rows[0]).toMatchObject({
  taskId: `fallback:${deviceA.id}`, isFallback: true,
  deviceId: deviceA.id, deviceName: `Device A ${unique}`, deviceCount: 1,
  projectId: projectA.id, projectName: `Project A ${unique}`, projectCount: 1
});

const filtered = await service.getTasks({
  from: "2026-07-15", to: "2026-07-15", timeZone: "UTC", tool: tool.slug,
  deviceId: deviceA.id, projectId: projectA.id, model: "gpt-5"
});
expect(filtered.rows.find((row) => row.taskId === `task-alpha-${unique}`)).toMatchObject({
  eventCount: 1, totalTokens: 16
});

for (const [sortBy, sortDir, firstTask] of [
  ["lastActivityAt", "desc", `fallback:${deviceA.id}`],
  ["lastActivityAt", "asc", `task-alpha-${unique}`],
  ["eventCount", "desc", `task-alpha-${unique}`],
  ["eventCount", "asc", `fallback:${deviceA.id}`],
  ["totalTokens", "desc", `task-alpha-${unique}`],
  ["totalTokens", "asc", `fallback:${deviceA.id}`],
  ["costUsd", "desc", `task-alpha-${unique}`],
  ["costUsd", "asc", `fallback:${deviceA.id}`]
] as const) {
  const sorted = await service.getTasks({
    from: "2026-07-15", to: "2026-07-15", timeZone: "UTC", tool: tool.slug,
    model: "gpt-5", sortBy, sortDir
  });
  expect(sorted.rows[0]?.taskId).toBe(firstTask);
}

const ties = await service.getTasks({
  from: "2026-07-15", to: "2026-07-15", timeZone: "UTC", tool: tool.slug,
  model: "tie-model", sortBy: "totalTokens", sortDir: "desc"
});
expect(ties.rows.map((row) => row.taskId)).toEqual([
  `task-a-tie-${unique}`, `task-b-tie-${unique}`
]);
```

Insert the rows with these exact totals: `task-alpha` events `(10,2,3,1,16,0.10)` and `(20,4,6,2,32,0.20)`, plus fallback `(5,1,0,0,6,0.05)` for input, output, cache read, cache write, total, and cost. Also insert `task-a-tie` and `task-b-tie` events with `model: "tie-model"`, identical `occurredAt`, token fields, and cost; only their task and source IDs differ. This makes the final assertion prove the task-ID tie-breaker.

- [ ] **Step 2: Run RED verification**

```bash
npm --workspace @codex-usage-dashboard/server run test -- queries.integration.test.ts
npm --workspace @codex-usage-dashboard/server run typecheck
```

Expected: database test or typecheck fails because `getTasks` does not exist.

- [ ] **Step 3: Add task types and grouped query**

Import `countDistinct`, `max`, and `min`. Add:

```ts
export type TaskSortBy = "lastActivityAt" | "eventCount" | "totalTokens" | "costUsd";
type TaskQuery = UsageFilters & {
  limit?: number; offset?: number; sortBy?: TaskSortBy; sortDir?: SortDir;
};
```

Extend `AdminQueryService` with `getTasks(filters: TaskQuery)`. Build this grouped subquery:

```ts
const grouped = adminDb().select({
  taskId: usageEvents.taskId,
  startedAt: min(usageEvents.occurredAt).as("started_at"),
  lastActivityAt: max(usageEvents.occurredAt).as("last_activity_at"),
  deviceCount: countDistinct(usageEvents.deviceId).as("device_count"),
  deviceId: sql<string | null>`case when count(distinct ${usageEvents.deviceId}) = 1 then min(${usageEvents.deviceId}::text) else null end`.as("device_id"),
  projectCount: countDistinct(usageEvents.projectId).as("project_count"),
  projectId: sql<string | null>`case when count(distinct ${usageEvents.projectId}) = 1 then min(${usageEvents.projectId}::text) else null end`.as("project_id"),
  eventCount: count().as("event_count"),
  inputTokens: sum(usageEvents.inputTokens).as("input_tokens"),
  outputTokens: sum(usageEvents.outputTokens).as("output_tokens"),
  cacheReadTokens: sum(usageEvents.cacheReadTokens).as("cache_read_tokens"),
  cacheWriteTokens: sum(usageEvents.cacheWriteTokens).as("cache_write_tokens"),
  totalTokens: sum(usageEvents.totalTokens).as("total_tokens"),
  costUsd: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)`.as("cost_usd")
}).from(usageEvents)
  .innerJoin(tools, eq(usageEvents.toolId, tools.id))
  .where(eventWhere(filters)).groupBy(usageEvents.taskId).as("task_groups");
```

Select from `grouped`, join one-value IDs to their names, sort, and paginate:

```ts
const sortColumn = filters.sortBy === "eventCount" ? grouped.eventCount
  : filters.sortBy === "totalTokens" ? grouped.totalTokens
    : filters.sortBy === "costUsd" ? grouped.costUsd
      : grouped.lastActivityAt;
const order = filters.sortDir === "asc" ? asc : desc;
const rows = await adminDb().select({
  taskId: grouped.taskId,
  startedAt: grouped.startedAt,
  lastActivityAt: grouped.lastActivityAt,
  deviceId: grouped.deviceId,
  deviceName: devices.name,
  deviceCount: grouped.deviceCount,
  projectId: grouped.projectId,
  projectName: projects.displayName,
  projectCount: grouped.projectCount,
  eventCount: grouped.eventCount,
  inputTokens: grouped.inputTokens,
  outputTokens: grouped.outputTokens,
  cacheReadTokens: grouped.cacheReadTokens,
  cacheWriteTokens: grouped.cacheWriteTokens,
  totalTokens: grouped.totalTokens,
  costUsd: grouped.costUsd
}).from(grouped)
  .leftJoin(devices, eq(devices.id, sql`${grouped.deviceId}::uuid`))
  .leftJoin(projects, eq(projects.id, sql`${grouped.projectId}::uuid`))
  .orderBy(order(sortColumn), asc(grouped.taskId))
  .limit(clampLimit(filters.limit))
  .offset(Math.max(0, filters.offset ?? 0));

const [totalRow] = await adminDb().select({ total: countDistinct(usageEvents.taskId) })
  .from(usageEvents)
  .innerJoin(tools, eq(usageEvents.toolId, tools.id))
  .where(eventWhere(filters));
```

Normalize counts, token aggregates, and cost with `numberFromAggregate`, set `isFallback: row.taskId.startsWith("fallback:")`, and return `total: numberFromAggregate(totalRow?.total)`.

- [ ] **Step 4: Run GREEN verification**

```bash
npm --workspace @codex-usage-dashboard/server run test -- queries.integration.test.ts
npm --workspace @codex-usage-dashboard/server run typecheck
```

Expected: PASS, with database tests explicitly skipped only when `TEST_DATABASE_URL` is absent.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/admin/queries.ts apps/server/src/admin/queries.integration.test.ts
git commit -m "feat(server): aggregate usage by task"
```

---

### Task 2: Tasks Admin Route

**Files:**
- Modify: `apps/server/src/admin/routes.ts`
- Test: `apps/server/src/admin/routes.test.ts`

**Interfaces:**
- Consumes: `AdminQueryService.getTasks` and `TaskSortBy`.
- Produces: authenticated `GET /api/admin/tasks` with validated pagination and task sorting.

- [ ] **Step 1: Write failing route tests**

Add `getTasks` to the query-service fixture and assert forwarding:

```ts
queryService.getTasks = async (input) => { seenInput = input; return { rows: [], total: 0 }; };
const response = await app.inject({
  method: "GET",
  url: "/api/admin/tasks?from=2026-05-01&to=2026-05-30&limit=25&offset=50&sortBy=eventCount&sortDir=asc",
  headers: { cookie }
});
expect(response.statusCode).toBe(200);
expect(seenInput).toMatchObject({
  ...filters, timeZone: "Asia/Tokyo", limit: 25, offset: 50,
  sortBy: "eventCount", sortDir: "asc"
});
```

Also assert `sortBy=model`, `sortDir=sideways`, `limit=-1`, and `offset=-1` return `400 { error: "invalid filters" }` without calling `getTasks`.

- [ ] **Step 2: Run RED verification**

```bash
npm --workspace @codex-usage-dashboard/server run test -- routes.test.ts
```

Expected: FAIL because `/api/admin/tasks` is not registered.

- [ ] **Step 3: Register route and parser**

```ts
app.get("/api/admin/tasks", async (request, reply) => {
  if (!requireAdmin(request, reply, env)) return;
  const filters = parseUsageFilters(request.query);
  if (!filters) return reply.code(400).send({ error: "invalid filters" });
  const query = request.query as Record<string, unknown>;
  const pagination = parsePagination(query);
  const sort = parseTaskSort(query);
  if (!pagination || !sort) return reply.code(400).send({ error: "invalid filters" });
  return queryService.getTasks({ ...filters, ...pagination, ...sort });
});

function parseTaskSort(query: Record<string, unknown>): { sortBy?: TaskSortBy; sortDir?: SortDir } | null {
  const sortBy = optionalString(query.sortBy);
  const sortDir = optionalString(query.sortDir);
  if (sortBy && !["lastActivityAt", "eventCount", "totalTokens", "costUsd"].includes(sortBy)) return null;
  if (sortDir && !isSortDir(sortDir)) return null;
  return { sortBy: sortBy as TaskSortBy | undefined, sortDir: sortDir as SortDir | undefined };
}
```

- [ ] **Step 4: Run GREEN verification and commit**

```bash
npm --workspace @codex-usage-dashboard/server run test -- routes.test.ts
npm --workspace @codex-usage-dashboard/server run typecheck
git add apps/server/src/admin/routes.ts apps/server/src/admin/routes.test.ts
git commit -m "feat(server): expose task usage endpoint"
```

---

### Task 3: Dashboard API Client

**Files:**
- Modify: `apps/server-web/src/api.ts`
- Test: `apps/server-web/src/api.test.ts`

**Interfaces:**
- Consumes: `/api/admin/tasks`.
- Produces: `TaskUsage`, `TaskSortBy`, `TaskPage`, and `DashboardData.tasks`.

- [ ] **Step 1: Write failing request test**

Mock `/api/admin/tasks`, pass task page `{ limit: 25, offset: 50, sortBy: "eventCount", sortDir: "asc" }` as the fourth `getDashboardData` argument, and assert the request is:

```text
/api/admin/tasks?from=2026-05-01&to=2026-05-30&tool=codex-cli&deviceId=00000000-0000-4000-8000-000000000001&projectId=00000000-0000-4000-8000-000000000002&model=gpt-5&timeZone=UTC&limit=25&offset=50&sortBy=eventCount&sortDir=asc
```

- [ ] **Step 2: Run RED verification**

```bash
npm --workspace @codex-usage-dashboard/server-web run test -- api.test.ts
```

Expected: FAIL because tasks are not fetched.

- [ ] **Step 3: Add types and parallel request**

```ts
export type TaskUsage = UsageSummary & {
  taskId: string; isFallback: boolean; startedAt: string; lastActivityAt: string;
  deviceId: string | null; deviceName: string | null; deviceCount: number;
  projectId: string | null; projectName: string | null; projectCount: number;
};
export type TaskSortBy = "lastActivityAt" | "eventCount" | "totalTokens" | "costUsd";
export type TaskPage = { limit: number; offset: number; sortBy: TaskSortBy; sortDir: SortDir };
```

Add `tasks: { rows: TaskUsage[]; total: number }` to `DashboardData`. Accept `taskPage` as a fourth argument after project sort, with a default of `{ limit: 25, offset: 0, sortBy: "lastActivityAt", sortDir: "desc" }` so existing callers remain type-safe during this commit. Construct its query, add the request to `Promise.all`, and return `tasks`.

- [ ] **Step 4: Run test and commit**

```bash
npm --workspace @codex-usage-dashboard/server-web run test -- api.test.ts
npm --workspace @codex-usage-dashboard/server-web run typecheck
git add apps/server-web/src/api.ts apps/server-web/src/api.test.ts
git commit -m "feat(web): load task usage data"
```

---

### Task 4: Tasks Tab and Table

**Files:**
- Create: `apps/server-web/src/components/TasksTable.tsx`
- Create: `apps/server-web/src/components/TasksTable.test.tsx`
- Modify: `apps/server-web/src/components/DataExplorer.tsx`
- Modify: `apps/server-web/src/components/DataExplorer.test.tsx`
- Modify: `apps/server-web/src/dashboard-types.ts`
- Modify: `apps/server-web/src/styles.css`

**Interfaces:**
- Consumes: `TaskUsage` and `Translate`.
- Produces: `TaskSort` and `<TasksTable>`.

- [ ] **Step 1: Write failing component tests**

Assert tab order:

```ts
expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
  "Events", "Tasks", "Devices", "Projects", "Prices"
]);
```

Render a fallback task with `deviceCount: 2` and `projectCount: 2`. Assert two `Multiple` cells, the `Fallback task` label, full task ID title, `eventCount-asc` callback, disabled Previous, and enabled Next.

- [ ] **Step 2: Run RED verification**

```bash
npm --workspace @codex-usage-dashboard/server-web run test -- DataExplorer.test.tsx TasksTable.test.tsx
```

Expected: FAIL because the tab and component do not exist.

- [ ] **Step 3: Implement types, tab, and table**

```ts
export type DashboardTab = "events" | "tasks" | "devices" | "projects" | "prices";
export type TaskSort =
  | "lastActivityAt-desc" | "lastActivityAt-asc"
  | "eventCount-desc" | "eventCount-asc"
  | "totalTokens-desc" | "totalTokens-asc"
  | "costUsd-desc" | "costUsd-asc";
```

Insert `tasks` after `events`. Build `TasksTable` with the established panel header, sort control, pagination, table wrap, number/currency formatting, and UTC timestamp formatting. Use these columns: Task, First event, Last activity, Device, Project, Events, Input, Output, Cache, Total tokens, Cost. Render:

```tsx
const deviceLabel = row.deviceCount > 1 ? t("Multiple") : row.deviceName ?? t("Unknown");
const projectLabel = row.projectCount > 1 ? t("Multiple") : row.projectName ?? t("Unknown");
```

Use `.mono` plus `title={row.taskId}` for the ID, and add compact `.task-id-cell` and `.task-kind` styles without introducing cards.

- [ ] **Step 4: Run GREEN verification and commit**

```bash
npm --workspace @codex-usage-dashboard/server-web run test -- DataExplorer.test.tsx TasksTable.test.tsx
git add apps/server-web/src/components/TasksTable.tsx apps/server-web/src/components/TasksTable.test.tsx apps/server-web/src/components/DataExplorer.tsx apps/server-web/src/components/DataExplorer.test.tsx apps/server-web/src/dashboard-types.ts apps/server-web/src/styles.css
git commit -m "feat(web): add task usage table"
```

---

### Task 5: App State and Locales

**Files:**
- Modify: `apps/server-web/src/App.tsx`
- Modify: `apps/server-web/src/App.test.tsx`
- Modify: `apps/server-web/src/locales/zh.ts`
- Modify: `apps/server-web/src/locales/ja.ts`
- Modify: `apps/server-web/src/locales/ko.ts`

**Interfaces:**
- Consumes: Tasks API data and `<TasksTable>`.
- Produces: independent task state integrated with refresh and filters.

- [ ] **Step 1: Write failing App interaction test**

Return one fallback task from `handleRequest()`. Click Tasks, assert `Usage tasks` and the task ID, change sort to `eventCount-asc`, and assert `/api/admin/tasks` contains `sortBy=eventCount&sortDir=asc`. Click task Next, change Device, and assert the later task request contains `offset=0`; retain the Events sort check to prove independence.

- [ ] **Step 2: Run RED verification**

```bash
npm --workspace @codex-usage-dashboard/server-web run test -- App.test.tsx
```

Expected: FAIL because App has no task workflow.

- [ ] **Step 3: Wire independent state**

```ts
const taskPageLimit = 25;
const [taskOffset, setTaskOffset] = useState(0);
const [taskSort, setTaskSort] = useState<TaskSort>("lastActivityAt-desc");

function taskSortToRequest(sort: TaskSort): { sortBy: TaskSortBy; sortDir: SortDir } {
  const [sortBy, sortDir] = sort.split("-") as [TaskSortBy, SortDir];
  return { sortBy, sortDir };
}
```

Pass task page as the fourth `getDashboardData` argument, add task dependencies to `refresh`, reset both offsets in `updateFilter`, and render `TasksTable` for `activeTab === "tasks"`.

- [ ] **Step 4: Add locale strings**

Translate these keys in `zh.ts`, `ja.ts`, and `ko.ts`; English continues to use the key itself:

```text
Tasks
Usage tasks
Task
First event
Last activity
Fallback task
Multiple
Unknown
No usage tasks in this range
Last activity newest first
Last activity oldest first
Task pagination
```

Import `translations` in `App.test.tsx` and assert every locale has real task copy:

```ts
expect(translations.zh.Tasks).toBe("任务");
expect(translations.ja.Tasks).toBe("タスク");
expect(translations.ko.Tasks).toBe("작업");
expect(translations.zh["Fallback task"]).not.toBe("Fallback task");
expect(translations.ja["Fallback task"]).not.toBe("Fallback task");
expect(translations.ko["Fallback task"]).not.toBe("Fallback task");
```

- [ ] **Step 5: Run GREEN verification and commit**

```bash
npm --workspace @codex-usage-dashboard/server-web run test -- App.test.tsx TasksTable.test.tsx DataExplorer.test.tsx
npm --workspace @codex-usage-dashboard/server-web run typecheck
git add apps/server-web/src/App.tsx apps/server-web/src/App.test.tsx apps/server-web/src/locales/zh.ts apps/server-web/src/locales/ja.ts apps/server-web/src/locales/ko.ts
git commit -m "feat(web): wire task usage workflow"
```

---

### Task 6: Full Verification and Browser QA

**Files:**
- Modify only a directly affected file if a verification failure identifies a concrete defect.

**Interfaces:**
- Consumes: completed endpoint and Tasks tab.
- Produces: verified task grouping ready for review.

- [ ] **Step 1: Run repository-wide checks**

```bash
npm test
npm run typecheck
npm run build
npm run check:open-source
git diff --check origin/main...HEAD
```

Expected: tests pass, database-only tests may be explicitly skipped without `TEST_DATABASE_URL`, all other commands exit zero, and diff check prints nothing.

- [ ] **Step 2: Start and inspect the local app**

```bash
npm run dev:server
npm run dev:web
```

Verify desktop and narrow viewports: tab order, default and changed server sorts, independent pagination, filter resets, fallback and Multiple labels, full-ID tooltip, empty state, all four languages, and horizontal overflow without clipped controls.

- [ ] **Step 3: Capture and inspect screenshots**

Capture the Tasks tab at desktop and narrow widths. Use `view_image` to inspect table density, header alignment, controls, truncation, light/dark themes, and focus visibility. Remove temporary screenshots before handoff.

- [ ] **Step 4: Re-run affected checks after any QA correction**

```bash
npm --workspace @codex-usage-dashboard/server-web run test
npm --workspace @codex-usage-dashboard/server-web run typecheck
npm run build
git diff --check origin/main...HEAD
```

Expected: PASS. Commit tracked QA corrections with `git add apps/server-web/src && git commit -m "fix(web): polish task usage workflow"`; do not create an empty commit.

- [ ] **Step 5: Verify final branch state**

```bash
git status -sb
git log --oneline origin/main..HEAD
```

Expected: clean `agent/task-usage-grouping` branch containing design, plan, server, route, client, table, and dashboard commits.
