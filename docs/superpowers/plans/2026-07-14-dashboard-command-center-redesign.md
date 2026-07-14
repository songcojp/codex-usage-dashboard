# Dashboard Command Center Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the authenticated usage dashboard as the approved responsive Data Command Center while preserving every existing API and interaction contract.

**Architecture:** `App` remains the single owner of authentication, fetched data, filters, refresh timing, sorting, pagination, language, theme, and errors. Focused presentational components own the app shell, filters, metrics/trend, and data explorer; they consume explicit values and callbacks and introduce no fetching effects or duplicate server state.

**Tech Stack:** React 19, TypeScript, Vite 8, ECharts 6, Vitest 4, Testing Library, CSS.

## Global Constraints

- Do not change backend, API, database, authentication, permission, ingestion, pricing, sorting, or pagination behavior.
- Do not add a client-side router or a new dependency.
- Keep Events, Devices, Projects, and Prices as Data explorer tabs.
- Use a 200 px desktop sidebar, a 1440 px maximum main content width, 24 px desktop gutters, and a 1:2 metrics-to-trend ratio.
- Desktop is 1024 px and above; tablet is 641–1023 px; mobile is 640 px and below; 320 px is the supported minimum width.
- Preserve light/dark theme, four dashboard languages plus Auto, immediate filter refresh, and the 60-second summary-only refresh.
- Keep tables as tables with contained horizontal scrolling; do not convert rows into cards.
- Use code-native UI text and controls. No raster asset is shipped as interface content.
- Follow TDD: every behavior change starts with a failing test that is observed before implementation.

## Pre-implementation Visual Gate

Before Task 1, invoke `build-web-apps:frontend-app-builder` and `imagegen`. Generate one complete 1440 × 1000 authenticated desktop concept and one 390 × 844 mobile concept from the approved design spec at `docs/superpowers/specs/2026-07-14-dashboard-command-center-redesign-design.md`. The concepts must preserve the accepted information architecture and interaction rules. Obtain user approval, then record the accepted image paths and extract exact tokens for spacing, typography, radii, borders, shadows, icon treatment, and palette. Do not write production code before this gate passes.

## File Structure

- Create `apps/server-web/src/dashboard-types.ts`: shared UI-only types used across extracted components.
- Create `apps/server-web/src/components/DashboardIcons.tsx`: consistent code-native SVG icon primitives.
- Create `apps/server-web/src/components/AppShell.tsx`: responsive sidebar, mobile menu, page anchors, and main content frame.
- Create `apps/server-web/src/components/FilterToolbar.tsx`: always-visible filters, More filters disclosure, and mobile filter panel.
- Create `apps/server-web/src/components/MetricsOverview.tsx`: metric hierarchy, rolling values, and initial skeletons.
- Create `apps/server-web/src/components/TrendPanel.tsx`: chart controls, option generation, chart lifecycle, and empty/loading states.
- Create `apps/server-web/src/components/DataExplorer.tsx`: tabs, tables, pagination controls, and price management surface.
- Modify `apps/server-web/src/App.tsx`: retain orchestration and compose the extracted components.
- Modify `apps/server-web/src/App.test.tsx`: retain integration coverage and add shell/filter integration assertions.
- Create focused component tests beside each component.
- Modify `apps/server-web/src/styles.css`: implement the approved design system and responsive layout.
- Modify `apps/server-web/src/styles.test.ts`: lock responsive breakpoints and critical layout selectors.

---

### Task 1: Lock shared UI contracts and icon primitives

**Files:**
- Create: `apps/server-web/src/dashboard-types.ts`
- Create: `apps/server-web/src/components/DashboardIcons.tsx`
- Create: `apps/server-web/src/components/DashboardIcons.test.tsx`

**Interfaces:**
- Produces: `DashboardTab`, `DashboardSection`, `Theme`, `Translate`, `EventSort`, `ProjectSort`, and `PriceDraft` types.
- Produces: `DashboardIcon({ name, size?, className? })` using `currentColor` SVG output.

- [ ] **Step 1: Write the failing icon accessibility test**

```tsx
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { DashboardIcon } from "./DashboardIcons.js";

describe("DashboardIcon", () => {
  test("renders a decorative currentColor icon", () => {
    const { container } = render(<DashboardIcon name="dashboard" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
  });
});
```

- [ ] **Step 2: Run the focused test and observe RED**

Run: `npm --workspace @codex-usage-dashboard/server-web test -- DashboardIcons.test.tsx`

Expected: FAIL because `DashboardIcons.tsx` does not exist.

- [ ] **Step 3: Add the shared types and icon implementation**

```ts
// dashboard-types.ts
export type DashboardTab = "events" | "devices" | "projects" | "prices";
export type DashboardSection = "overview" | "trend" | "explorer";
export type Theme = "light" | "dark";
export type Language = "zh" | "ja" | "en" | "ko";
export type LanguageSetting = "auto" | Language;
export type Translate = (key: string) => string;
export type EventSort =
  | "occurredAt-desc" | "occurredAt-asc"
  | "totalTokens-desc" | "totalTokens-asc"
  | "costUsd-desc" | "costUsd-asc"
  | "inputTokens-desc" | "inputTokens-asc"
  | "outputTokens-desc" | "outputTokens-asc"
  | "cacheTokens-desc" | "cacheTokens-asc";
export type ProjectSort =
  | "updatedAt-desc" | "updatedAt-asc"
  | "eventCount-desc" | "eventCount-asc"
  | "totalTokens-desc" | "totalTokens-asc"
  | "costUsd-desc" | "costUsd-asc";
export type PriceDraft = {
  model: string;
  inputCostPerMillionUsd: string;
  outputCostPerMillionUsd: string;
  cacheReadCostPerMillionUsd: string;
  cacheWriteCostPerMillionUsd: string;
};
```

Implement `DashboardIcon` with an exhaustive `IconName` union containing `dashboard`, `trend`, `explorer`, `prices`, `menu`, `close`, `sun`, `moon`, `refresh`, and `more`. Each SVG uses `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, `strokeWidth={2}`, `strokeLinecap="round"`, `strokeLinejoin="round"`, `focusable="false"`, and `aria-hidden="true"`.

- [ ] **Step 4: Run focused test and typecheck**

Run: `npm --workspace @codex-usage-dashboard/server-web test -- DashboardIcons.test.tsx && npm --workspace @codex-usage-dashboard/server-web run typecheck`

Expected: PASS with one icon test and zero TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server-web/src/dashboard-types.ts apps/server-web/src/components/DashboardIcons.tsx apps/server-web/src/components/DashboardIcons.test.tsx
git commit -m "refactor(web): add dashboard UI contracts"
```

### Task 2: Build the responsive app shell and page navigation

**Files:**
- Create: `apps/server-web/src/components/AppShell.tsx`
- Create: `apps/server-web/src/components/AppShell.test.tsx`
- Modify: `apps/server-web/src/App.tsx`

**Interfaces:**
- Consumes: `DashboardSection`, `DashboardTab`, `Theme`, `Translate`, and `DashboardIcon`.
- Produces: `AppShellProps` with `activeSection`, `adminEmail`, `children`, `loading`, `theme`, `t`, `onLanguageChange`, `onLogout`, `onNavigate`, `onOpenPrices`, `onRefresh`, and `onThemeToggle`.
- Produces section element IDs: `dashboard-overview`, `dashboard-trend`, and `dashboard-explorer`.

- [ ] **Step 1: Write failing navigation tests**

```tsx
test("uses page navigation without duplicating data tabs", () => {
  const onNavigate = vi.fn();
  const onOpenPrices = vi.fn();
  render(<ShellFixture onNavigate={onNavigate} onOpenPrices={onOpenPrices} />);
  fireEvent.click(screen.getByRole("button", { name: "Usage trend" }));
  expect(onNavigate).toHaveBeenCalledWith("trend");
  fireEvent.click(screen.getByRole("button", { name: "Model prices" }));
  expect(onOpenPrices).toHaveBeenCalledOnce();
  expect(screen.queryByRole("tab", { name: "Events" })).toBeNull();
});

test("mobile navigation closes after selection", () => {
  render(<ShellFixture />);
  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
  expect(screen.getByRole("navigation", { name: "Dashboard navigation" })).toHaveAttribute("data-mobile-open", "true");
  fireEvent.click(screen.getByRole("button", { name: "Data explorer" }));
  expect(screen.getByRole("navigation", { name: "Dashboard navigation" })).toHaveAttribute("data-mobile-open", "false");
});
```

- [ ] **Step 2: Run focused test and observe RED**

Run: `npm --workspace @codex-usage-dashboard/server-web test -- AppShell.test.tsx`

Expected: FAIL because `AppShell` and `ShellFixture` imports cannot resolve.

- [ ] **Step 3: Implement `AppShell` and integrate section refs**

Use semantic `<nav aria-label="Dashboard navigation">`, `<header>`, and `<main>`. Store only `mobileNavigationOpen` inside `AppShell`. Navigation buttons call `onNavigate(section)` and then close the mobile menu. The Model prices button calls `onOpenPrices()` and closes the menu.

In `App`, create refs for overview, trend, and explorer and one stable callback:

```tsx
const sectionRefs = {
  overview: overviewSection,
  trend: trendSection,
  explorer: explorerSection
} as const;

const handleNavigate = useCallback((section: DashboardSection) => {
  setActiveSection(section);
  sectionRefs[section].current?.scrollIntoView({ behavior: "smooth", block: "start" });
  sectionRefs[section].current?.focus({ preventScroll: true });
}, []);

const handleOpenPrices = useCallback(() => {
  setActiveTab("prices");
  handleNavigate("explorer");
}, [handleNavigate]);
```

Give each section `tabIndex={-1}` and the exact IDs defined above. Keep all current action handlers and language controls wired through props.

- [ ] **Step 4: Run focused and existing integration tests**

Run: `npm --workspace @codex-usage-dashboard/server-web test -- AppShell.test.tsx App.test.tsx`

Expected: PASS with all existing login, filter, summary refresh, sorting, pricing, and language assertions intact.

- [ ] **Step 5: Commit**

```bash
git add apps/server-web/src/components/AppShell.tsx apps/server-web/src/components/AppShell.test.tsx apps/server-web/src/App.tsx
git commit -m "feat(web): add command center app shell"
```

### Task 3: Add progressive-disclosure filters

**Files:**
- Create: `apps/server-web/src/components/FilterToolbar.tsx`
- Create: `apps/server-web/src/components/FilterToolbar.test.tsx`
- Modify: `apps/server-web/src/App.tsx`
- Modify: `apps/server-web/src/App.test.tsx`

**Interfaces:**
- Consumes: `DashboardData`, `UsageFilters`, `Translate`, model names, and `onChange<K extends keyof UsageFilters>(key: K, value: UsageFilters[K])`.
- Produces: `FilterToolbar` with visible date/tool/model/project controls and disclosed device/time-zone controls.

- [ ] **Step 1: Write failing disclosure and filter tests**

```tsx
test("keeps primary filters visible and discloses secondary filters", () => {
  render(<FilterFixture />);
  expect(screen.getByLabelText("From")).toBeVisible();
  expect(screen.getByLabelText("Project")).toBeVisible();
  expect(screen.queryByLabelText("Device")).toBeNull();
  const trigger = screen.getByRole("button", { name: "More filters" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByLabelText("Device")).toBeVisible();
  expect(screen.getByLabelText("Time zone")).toBeVisible();
});

test("secondary filters still update immediately", () => {
  const onChange = vi.fn();
  render(<FilterFixture onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "More filters" }));
  fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "UTC" } });
  expect(onChange).toHaveBeenCalledWith("timeZone", "UTC");
});
```

- [ ] **Step 2: Run focused test and observe RED**

Run: `npm --workspace @codex-usage-dashboard/server-web test -- FilterToolbar.test.tsx`

Expected: FAIL because `FilterToolbar` does not exist.

- [ ] **Step 3: Implement `FilterToolbar` and replace inline filters**

Store `moreFiltersOpen` inside the toolbar. The trigger uses `aria-expanded`, `aria-controls="dashboard-more-filters"`, and localized text. The controlled region has `id="dashboard-more-filters"`. Render the region only while open so closed controls are absent from the accessibility tree. Reuse the existing option data and pass every change immediately to `App`'s existing `updateFilter` path.

Add translations for `More filters`, `Close filters`, `Date range`, `Dashboard`, `Usage trend`, `Data explorer`, `Model prices`, `Open navigation`, and `Close navigation` in all four non-English dictionaries.

- [ ] **Step 4: Run focused and integration tests**

Run: `npm --workspace @codex-usage-dashboard/server-web test -- FilterToolbar.test.tsx App.test.tsx`

Expected: PASS; existing query-parameter assertions still observe `deviceId`, `projectId`, `model`, and `timeZone` updates.

- [ ] **Step 5: Commit**

```bash
git add apps/server-web/src/components/FilterToolbar.tsx apps/server-web/src/components/FilterToolbar.test.tsx apps/server-web/src/App.tsx apps/server-web/src/App.test.tsx
git commit -m "feat(web): reorganize dashboard filters"
```

### Task 4: Extract the metrics and trend overview

**Files:**
- Create: `apps/server-web/src/components/MetricsOverview.tsx`
- Create: `apps/server-web/src/components/MetricsOverview.test.tsx`
- Create: `apps/server-web/src/components/TrendPanel.tsx`
- Create: `apps/server-web/src/components/TrendPanel.test.tsx`
- Modify: `apps/server-web/src/App.tsx`
- Modify: `apps/server-web/src/App.test.tsx`

**Interfaces:**
- `MetricsOverview({ summary, initialLoading, t })` consumes `UsageSummary | undefined`.
- `TrendPanel({ points, initialLoading, language, theme, t })` owns `trendMode` and `trendFilter` UI state.
- `createTrendChartOption(points, t, language, theme?, trendMode?, trendFilter?)` remains exported from `TrendPanel.tsx`.

- [ ] **Step 1: Write failing metric hierarchy and chart tests**

```tsx
test("emphasizes total tokens and renders the four supporting metrics", () => {
  render(<MetricsOverview summary={summaryFixture} initialLoading={false} t={(key) => key} />);
  expect(screen.getByLabelText("Total tokens metric")).toHaveAttribute("data-emphasis", "primary");
  expect(screen.getAllByRole("article")).toHaveLength(5);
});

test("renders size-stable metric skeletons during initial loading", () => {
  const { container } = render(<MetricsOverview initialLoading t={(key) => key} />);
  expect(container.querySelectorAll(".metric-skeleton")).toHaveLength(5);
});

test("filters the chart to cost without changing its source points", () => {
  const points = [trendPointFixture];
  const option = createTrendChartOption(points, (key) => key, "en", "light", "daily", "cost");
  expect(option.series).toHaveLength(1);
  expect(option.series[0]).toEqual(expect.objectContaining({ name: "Cost", data: [0.125] }));
  expect(points[0].cacheWriteTokens).toBe(10);
});
```

- [ ] **Step 2: Run focused tests and observe RED**

Run: `npm --workspace @codex-usage-dashboard/server-web test -- MetricsOverview.test.tsx TrendPanel.test.tsx`

Expected: FAIL because both components are missing.

- [ ] **Step 3: Move existing metric and trend code into focused components**

Move the existing rolling-digit implementation and format callbacks into `MetricsOverview.tsx`. Keep the current formatted accessible value in `.sr-only`. Replace geometry-shifting hover transforms with non-layout-changing border/shadow states.

Move `createTrendChartOption`, `TrendChart`, and chart control state into `TrendPanel.tsx`. Preserve ECharts registration, resize handling, disposal, cache aggregation, cumulative calculations, theme colors, and localized number formatting. Do not add a second chart instance or effect.

- [ ] **Step 4: Run focused tests, integration tests, and typecheck**

Run: `npm --workspace @codex-usage-dashboard/server-web test -- MetricsOverview.test.tsx TrendPanel.test.tsx App.test.tsx && npm --workspace @codex-usage-dashboard/server-web run typecheck`

Expected: PASS with zero TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server-web/src/components/MetricsOverview.tsx apps/server-web/src/components/MetricsOverview.test.tsx apps/server-web/src/components/TrendPanel.tsx apps/server-web/src/components/TrendPanel.test.tsx apps/server-web/src/App.tsx apps/server-web/src/App.test.tsx
git commit -m "refactor(web): extract dashboard overview"
```

### Task 5: Extract the Data explorer and preserve every table workflow

**Files:**
- Create: `apps/server-web/src/components/DataExplorer.tsx`
- Create: `apps/server-web/src/components/DataExplorer.test.tsx`
- Modify: `apps/server-web/src/App.tsx`
- Modify: `apps/server-web/src/App.test.tsx`

**Interfaces:**
- Consumes the existing rows, total, active tab, sorts, price draft, loading state, callbacks, and `Translate` function.
- Produces `DataExplorer` with one semantic tablist and the current Events, Devices, Projects, and Prices panels.

- [ ] **Step 1: Write a failing preservation test**

```tsx
test("keeps one data tablist and exposes the selected table workflow", () => {
  render(<DataExplorerFixture />);
  expect(screen.getAllByRole("tablist")).toHaveLength(1);
  expect(screen.getByRole("tab", { name: "Events" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
  expect(screen.getByLabelText("Sort")).toBeVisible();
  expect(screen.getByText("Project A")).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "Prices" }));
  expect(screen.getByDisplayValue("gpt-5")).toBeVisible();
});

test("renders a price mutation error beside the price form", () => {
  render(<DataExplorerFixture activeTab="prices" priceError="Failed to save model price" />);
  const form = screen.getByRole("form", { name: "Model prices" });
  expect(within(form).getByRole("alert")).toHaveTextContent("Failed to save model price");
});
```

- [ ] **Step 2: Run the focused test and observe RED**

Run: `npm --workspace @codex-usage-dashboard/server-web test -- DataExplorer.test.tsx`

Expected: FAIL because `DataExplorer` does not exist.

- [ ] **Step 3: Extract the existing tab panels**

Move `EventsTable`, `DevicesTable`, `ProjectsTable`, `PricesPanel`, `PanelHeader`, `TabButton`, and `EmptyRow` into `DataExplorer.tsx`. Move their private formatting and sort-conversion helpers only when exclusively used there; otherwise export the helper from `App.tsx` until all consumers move in the same commit. Preserve existing element labels, column order, price form actions, pagination disabled rules, and table minimum widths. Add `aria-label={t("Model prices")}` to the price form so it has an explicit form role and name.

Add a separate `priceError` state in `App`. Clear it at the start of save/delete actions, set it only when those mutations fail, and pass it to `DataExplorer`. Keep dashboard fetch errors in the existing global `error` state below the filter toolbar. Render `priceError` as `role="alert"` inside the Prices form before its fields.

Use a discriminated render in `DataExplorer`:

```tsx
<div className="data-explorer-panel" role="tabpanel" aria-labelledby={`data-tab-${activeTab}`}>
  {activeTab === "events" ? <EventsTable {...eventProps} /> : null}
  {activeTab === "devices" ? <DevicesTable {...deviceProps} /> : null}
  {activeTab === "projects" ? <ProjectsTable {...projectProps} /> : null}
  {activeTab === "prices" ? <PricesPanel {...priceProps} /> : null}
</div>
```

- [ ] **Step 4: Run Data explorer and full web tests**

Run: `npm --workspace @codex-usage-dashboard/server-web test`

Expected: PASS with all existing table, price, pagination, filtering, and sorting assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/server-web/src/components/DataExplorer.tsx apps/server-web/src/components/DataExplorer.test.tsx apps/server-web/src/App.tsx apps/server-web/src/App.test.tsx
git commit -m "refactor(web): extract data explorer"
```

### Task 6: Implement the approved visual system and responsive layouts

**Files:**
- Modify: `apps/server-web/src/styles.css`
- Modify: `apps/server-web/src/styles.test.ts`
- Modify: `apps/server-web/src/App.tsx`

**Interfaces:**
- Consumes the accepted desktop/mobile concept token inventory from the visual gate.
- Produces stable selectors for `.dashboard-shell`, `.dashboard-sidebar`, `.dashboard-main`, `.filter-toolbar`, `.overview-grid`, `.metrics-overview`, `.trend-panel`, `.data-explorer`, `.mobile-navigation-trigger`, and `.mobile-filter-panel`.

- [ ] **Step 1: Write failing CSS contract tests**

```ts
test("defines the command center grid and exact responsive boundaries", () => {
  expect(styles).toMatch(/\.dashboard-shell\s*\{[^}]*grid-template-columns:\s*200px minmax\(0,\s*1fr\)/s);
  expect(styles).toMatch(/\.overview-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(0,\s*2fr\)/s);
  expect(styles).toContain("@media (max-width: 1023px)");
  expect(styles).toContain("@media (max-width: 640px)");
  expect(styles).toContain("min-width: 320px");
});

test("keeps tables scrollable and removes geometry-shifting card hover", () => {
  expect(styles).toMatch(/\.table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
  expect(styles).not.toMatch(/\.metric-card:hover[^}]*translateY/);
});
```

- [ ] **Step 2: Run style tests and observe RED**

Run: `npm --workspace @codex-usage-dashboard/server-web test -- styles.test.ts`

Expected: FAIL because the command-center selectors and breakpoints do not exist.

- [ ] **Step 3: Implement the accepted token system and layouts**

Define tokens under `:root` and `[data-theme="dark"]` from the accepted concept. Implement the 200 px shell, 1440 px main-content maximum, 24 px gutters, 1:2 overview, tablet icon rail, mobile top navigation, mobile filter panel, stable loading skeletons, and contained table scrolling. Align the existing login page's spacing, typography, fields, language control, and theme button with the same token system without changing its fields or submission flow. Preserve explicit control typography and `prefers-reduced-motion`. Remove obsolete selectors only after their JSX consumers have been removed.

- [ ] **Step 4: Run web test, typecheck, and build**

Run: `npm --workspace @codex-usage-dashboard/server-web test && npm --workspace @codex-usage-dashboard/server-web run typecheck && npm --workspace @codex-usage-dashboard/server-web run build`

Expected: PASS; Vite emits one HTML file plus hashed CSS and JS assets.

- [ ] **Step 5: Commit**

```bash
git add apps/server-web/src/styles.css apps/server-web/src/styles.test.ts apps/server-web/src/App.tsx
git commit -m "feat(web): apply command center visual system"
```

### Task 7: Rendered fidelity, accessibility, and release verification

**Files:**
- Modify only files required by concrete QA findings from Tasks 1–6.
- Do not commit screenshots, traces, temporary browser scripts, or generated reports.

**Interfaces:**
- Produces a browser-verified implementation matching the accepted desktop and mobile concept images.

- [ ] **Step 1: Start the real local frontend and API fixtures**

Run the repository's local server and web scripts in persistent sessions:

```bash
npm run dev:server
npm run dev:web -- --host 127.0.0.1
```

Expected: API listens on port 3000 and Vite prints its exact local URL. If production authentication data is unavailable, use the existing test fetch fixture in a temporary QA harness outside the repository; do not commit credentials or fixtures.

- [ ] **Step 2: Capture required viewports with the Browser plugin or Playwright fallback**

Verify 1440 × 1000, 900 × 1000, 390 × 844, and 320 × 720 in light and dark themes. Capture login, authenticated overview, More filters open, mobile menu open, each Data explorer tab, initial loading, empty, and error states. Record the fallback reason if the Browser plugin is unavailable.

Expected: correct page identity, meaningful DOM, no framework overlay, no relevant console error, and no clipped primary action, label, or metric.

- [ ] **Step 3: Exercise the core interaction path**

Perform: login → open More filters → change Device and Time zone → switch Daily/Cumulative → switch Tokens/Cost → navigate sidebar anchors → open Model prices from sidebar → edit/save/delete a price → switch language → toggle theme → open and use mobile navigation.

Expected: every control updates real UI state or makes the existing API call; focus returns correctly after mobile overlays close.

- [ ] **Step 4: Run the fidelity comparison and fix all material mismatches**

Use `view_image` on both accepted concept images and the latest desktop/mobile browser screenshots. Compare at least: information hierarchy, first-viewport fit, typography, palette, spacing, radii/borders/shadows, icon treatment, chart/table density, mobile order, and visible copy. Repeat edit → test → screenshot → `view_image` until no fixable material mismatch remains.

- [ ] **Step 5: Run repository-wide verification**

Run: `npm run check:open-source && npm run typecheck && npm test && npm run build && git diff --check`

Expected: all commands exit 0. Vite's existing chunk-size advisory is acceptable; any new warning or error must be resolved.

- [ ] **Step 6: Commit QA fixes**

```bash
git add apps/server-web/src
git commit -m "fix(web): complete command center visual QA"
```

Skip the commit only when Step 4 required no file change. Confirm `git status --short` contains no unintended file before handoff.
