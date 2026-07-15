# Usage Ratios and Project Share Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct tool share calculations and add daily and all-time project Token share charts.

**Architecture:** Add one authenticated backend aggregation that returns raw daily and all-time project totals, fetch it in parallel with existing dashboard data, and calculate percentages in pure chart-option functions. Existing tool, Token type, and cost ratios remain line trends; all-time project share uses a pie chart.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM/PostgreSQL, React 19, ECharts 6, Vitest, Testing Library.

## Global Constraints

- `Tool ratio` means Token share, never cost share.
- Project daily mode follows `from`, `to`, and `timeZone`; project total mode ignores the date range.
- Project share ignores `projectId` but preserves `tool`, `deviceId`, and `model` filters.
- Repository-equivalent projects merge by `repoHash`; records without it remain distinct by project ID.
- Derivation functions must not mutate API response data.
- No project may be hidden in an `Other` bucket.

## File Map

- `apps/server/src/admin/queries.ts`: project aggregation types, merge helper, and service method.
- `apps/server/src/admin/queries.test.ts`: repository merge unit coverage.
- `apps/server/src/admin/queries.integration.test.ts`: daily versus all-time PostgreSQL coverage.
- `apps/server/src/admin/routes.ts`: authenticated project-ratio endpoint.
- `apps/server/src/admin/routes.test.ts`: endpoint filter coverage.
- `apps/server-web/src/api.ts`: response types and parallel API request.
- `apps/server-web/src/api.test.ts`: request parameter coverage.
- `apps/server-web/src/App.tsx`: pass project ratios to the chart.
- `apps/server-web/src/App.test.tsx`: dashboard API stub.
- `apps/server-web/src/components/TrendPanel.tsx`: corrected tool share and project line/pie options.
- `apps/server-web/src/components/TrendPanel.test.tsx`: ratio math, chart type, controls, empty data, and immutability.
- `apps/server-web/src/locales/{zh,ja,ko}.ts`: tool/project/total/no-data copy.

---

### Task 1: Project Ratio Aggregation Service

**Files:**
- Modify: `apps/server/src/admin/queries.ts`
- Modify: `apps/server/src/admin/queries.test.ts`
- Modify: `apps/server/src/admin/queries.integration.test.ts`

**Interfaces:**
- Consumes: `UsageFilters`, `reportingDaySql()`, `eventWhere()`, and project identity fields.
- Produces: `ProjectRatioResponse` and `getProjectRatios(filters: UsageFilters)`.

- [ ] **Step 1: Write the failing merge test**

Add this test to `queries.test.ts`:

~~~ts
expect(mergeProjectRatioRows([
  { day: "2026-07-14", id: "a", displayName: "Dashboard", repoHash: "repo", totalTokens: "20" },
  { day: "2026-07-14", id: "b", displayName: "Dashboard", repoHash: "repo", totalTokens: "30" },
  { day: "2026-07-15", id: "c", displayName: "Standalone", repoHash: null, totalTokens: "10" }
])).toEqual([
  { day: "2026-07-14", projectKey: "repo:repo", projectName: "Dashboard", totalTokens: 50 },
  { day: "2026-07-15", projectKey: "project:c", projectName: "Standalone", totalTokens: 10 }
]);
~~~

- [ ] **Step 2: Verify RED**

Run: `npm --workspace @codex-usage-dashboard/server run test -- src/admin/queries.test.ts`

Expected: FAIL because `mergeProjectRatioRows` is not exported.

- [ ] **Step 3: Add contracts and merge implementation**

Add in `queries.ts`:

~~~ts
export type ProjectRatioItem = {
  projectKey: string;
  projectName: string;
  totalTokens: number;
};

export type ProjectRatioResponse = {
  daily: Array<{ day: string; projects: ProjectRatioItem[] }>;
  total: ProjectRatioItem[];
};
~~~

Extend `AdminQueryService` with:

~~~ts
getProjectRatios(filters: UsageFilters): Promise<ProjectRatioResponse>;
~~~

Implement `mergeProjectRatioRows()` with a `Map` keyed by day plus `repo:<repoHash>` or `project:<id>`. Convert aggregate strings through `numberFromAggregate()` and preserve first-seen order.

- [ ] **Step 4: Add the aggregation method**

Inside `createAdminQueryService`, execute two independent queries with `Promise.all`. Daily selects `reportingDaySql(filters)`, project identity, and summed Tokens, and applies `{ ...filters, projectId: undefined }`. Total selects the same project identity and Tokens but calls `eventWhere()` with only `tool`, `deviceId`, and `model`, omitting `from`, `to`, and `projectId`. Group daily by day and project; group total by project. Merge both result sets by repository hash and shape daily rows as `{ day, projects }`.

- [ ] **Step 5: Verify GREEN and add integration coverage**

Run the unit test, then extend the existing database fixture with one matching project event outside the selected day. Assert the selected day contains only its daily Tokens while `total` contains both days:

~~~ts
expect(ratios.daily[0]?.projects).toContainEqual(
  expect.objectContaining({ projectName: project.displayName, totalTokens: 20 })
);
expect(ratios.total).toContainEqual(
  expect.objectContaining({ projectName: project.displayName, totalTokens: 40 })
);
~~~

Run: `npm --workspace @codex-usage-dashboard/server run test -- src/admin/queries.test.ts src/admin/queries.integration.test.ts`

Expected: PASS, or the existing integration test skips when `TEST_DATABASE_URL` is absent.

- [ ] **Step 6: Commit**

~~~bash
git add apps/server/src/admin/queries.ts apps/server/src/admin/queries.test.ts apps/server/src/admin/queries.integration.test.ts
git commit -m "feat(server): aggregate daily and total project token shares"
~~~

### Task 2: Authenticated Project Ratio Route

**Files:**
- Modify: `apps/server/src/admin/routes.ts`
- Modify: `apps/server/src/admin/routes.test.ts`

**Interfaces:**
- Consumes: `AdminQueryService.getProjectRatios()`.
- Produces: `GET /api/admin/project-ratios`.

- [ ] **Step 1: Write a failing route test**

Override `getProjectRatios` in the route-test service, call the new URL with valid date, time zone, tool, and project parameters, then assert HTTP 200 and:

~~~ts
expect(seenFilters).toMatchObject({
  from: "2026-07-01",
  to: "2026-07-15",
  tool: "codex-cli",
  timeZone: "UTC"
});
expect(seenFilters?.projectId).toBeUndefined();
~~~

- [ ] **Step 2: Verify RED**

Run: `npm --workspace @codex-usage-dashboard/server run test -- src/admin/routes.test.ts`

Expected: FAIL with 404.

- [ ] **Step 3: Add route implementation**

~~~ts
app.get("/api/admin/project-ratios", async (request, reply) => {
  if (!requireAdmin(request, reply, env)) return;
  const filters = parseUsageFilters(request.query);
  if (!filters) return reply.code(400).send({ error: "invalid filters" });
  return queryService.getProjectRatios({ ...filters, projectId: undefined });
});
~~~

Add a default empty implementation to the shared test service.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm --workspace @codex-usage-dashboard/server run test -- src/admin/routes.test.ts`

Expected: PASS.

~~~bash
git add apps/server/src/admin/routes.ts apps/server/src/admin/routes.test.ts
git commit -m "feat(server): expose project ratio reporting"
~~~

### Task 3: Dashboard API Wiring

**Files:**
- Modify: `apps/server-web/src/api.ts`
- Modify: `apps/server-web/src/api.test.ts`
- Modify: `apps/server-web/src/App.tsx`
- Modify: `apps/server-web/src/App.test.tsx`

**Interfaces:**
- Consumes: `/api/admin/project-ratios`.
- Produces: `ProjectRatioResponse`, `DashboardData.projectRatios`, and `TrendPanel.projectRatios`.

- [ ] **Step 1: Write a failing API test**

Teach the mock endpoint to return `{ daily: [], total: [] }`, then assert:

~~~ts
expect(paths).toContain(
  "/api/admin/project-ratios?from=2026-05-01&to=2026-05-30&tool=codex-cli&deviceId=00000000-0000-4000-8000-000000000001&model=gpt-5&timeZone=UTC"
);
expect(paths.find((path) => path.startsWith("/api/admin/project-ratios"))).not.toContain("projectId=");
~~~

- [ ] **Step 2: Verify RED**

Run: `npm --workspace @codex-usage-dashboard/server-web run test -- src/api.test.ts`

Expected: FAIL because the request is absent.

- [ ] **Step 3: Add types and parallel fetch**

Mirror `ProjectRatioItem` and `ProjectRatioResponse` in `api.ts`. Add `projectRatios` to `DashboardData`. Derive `projectRatioQuery` with `withoutKeys(filters, ["projectId"])`, fetch it in the existing `Promise.all`, and return it. Pass it into `TrendPanel`:

~~~tsx
projectRatios={data?.projectRatios ?? { daily: [], total: [] }}
~~~

Update the App test request handler with the empty project-ratio response.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm --workspace @codex-usage-dashboard/server-web run test -- src/api.test.ts src/App.test.tsx`

Expected: PASS.

~~~bash
git add apps/server-web/src/api.ts apps/server-web/src/api.test.ts apps/server-web/src/App.tsx apps/server-web/src/App.test.tsx
git commit -m "feat(web): load project ratio datasets"
~~~

### Task 4: Tool and Project Chart Math

**Files:**
- Modify: `apps/server-web/src/components/TrendPanel.tsx`
- Modify: `apps/server-web/src/components/TrendPanel.test.tsx`

**Interfaces:**
- Consumes: `TrendPoint[]` and `ProjectRatioResponse`.
- Produces: pure line and pie ECharts options.

- [ ] **Step 1: Write failing focused chart tests**

Create a tool fixture where Token share is 80/20 and cost share is 10/90. Assert `tool-ratio` returns 80 and 20. Create two project days where project A is missing from day two and assert daily lines A `[75, 0]`, B `[25, 100]`. Create all-time totals A 90 and B 10 and assert one `type: "pie"` series with raw values 90 and 10. Freeze or deep-clone inputs and assert they remain unchanged.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace @codex-usage-dashboard/server-web run test -- src/components/TrendPanel.test.tsx`

Expected: FAIL because `tool-ratio`, `project-ratio`, and project data are unsupported.

- [ ] **Step 3: Implement chart transformations**

- Import and register `PieChart`.
- Replace `app-ratio` with `tool-ratio` and add `project-ratio` to `TrendFilter`.
- Extend `createTrendChartOption()` with `projectRatios: ProjectRatioResponse = { daily: [], total: [] }`.
- Calculate tool share from `target.totalTokens / sum(totalTokens)`.
- For daily project mode, build the union of project keys with `Map`, calculate one denominator per day, and emit zero for a missing project.
- For total project mode, emit one pie series with `{ name, value: totalTokens }`, a scroll legend, tooltip percent formatting, and no Cartesian axes.
- Preserve finite zero values for zero denominators and localized empty series for empty results.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm --workspace @codex-usage-dashboard/server-web run test -- src/components/TrendPanel.test.tsx`

Expected: PASS.

~~~bash
git add apps/server-web/src/components/TrendPanel.tsx apps/server-web/src/components/TrendPanel.test.tsx
git commit -m "feat(web): chart tool and project token shares"
~~~

### Task 5: Controls, Localization, and Verification

**Files:**
- Modify: `apps/server-web/src/components/TrendPanel.tsx`
- Modify: `apps/server-web/src/components/TrendPanel.test.tsx`
- Modify: `apps/server-web/src/locales/zh.ts`
- Modify: `apps/server-web/src/locales/ja.ts`
- Modify: `apps/server-web/src/locales/ko.ts`

**Interfaces:**
- Consumes: chart modes from Task 4.
- Produces: translated controls and empty states.

- [ ] **Step 1: Write the failing control test**

Render `TrendPanel`, click `Project ratio`, and assert a `Total` button is present. Click `Tool ratio` and assert `Cumulative` returns. Also assert `App ratio` is absent.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace @codex-usage-dashboard/server-web run test -- src/components/TrendPanel.test.tsx`

Expected: FAIL because labels have not changed.

- [ ] **Step 3: Implement controls and translations**

Use this filter order:

~~~ts
["all", "tokens", "cost", "tool-ratio", "project-ratio", "token-ratio", "cost-ratio"]
~~~

Use `t(trendFilter === "project-ratio" ? "Total" : "Cumulative")` for the second mode. Add `Tool ratio`, `Project ratio`, `Total`, `No tools`, and `No project usage` in Chinese, Japanese, and Korean. Chinese values are `工具占比`, `项目占比`, `总量`, `无工具数据`, and `无项目用量数据`. Remove UI use of application copy.

- [ ] **Step 4: Run focused verification**

~~~bash
npm --workspace @codex-usage-dashboard/server-web run test -- src/components/TrendPanel.test.tsx src/api.test.ts src/App.test.tsx
npm --workspace @codex-usage-dashboard/server run test -- src/admin/queries.test.ts src/admin/routes.test.ts
npm run typecheck
~~~

Expected: all commands exit 0 without unexpected warnings.

- [ ] **Step 5: Run repository-wide verification**

~~~bash
npm test
npm run build
git diff --check
git status --short
~~~

Expected: tests, build, and whitespace checks pass; status contains only intended changes.

- [ ] **Step 6: Commit**

~~~bash
git add apps/server-web/src/components/TrendPanel.tsx apps/server-web/src/components/TrendPanel.test.tsx apps/server-web/src/locales/zh.ts apps/server-web/src/locales/ja.ts apps/server-web/src/locales/ko.ts
git commit -m "fix(web): align usage ratio labels and controls"
~~~
