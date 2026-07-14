# Dashboard Command Center Redesign

## Summary

Redesign the authenticated Codex Usage Dashboard as a compact data command center. The redesign changes information hierarchy, layout, navigation, responsive behavior, and frontend component boundaries while preserving all existing data, API, authentication, localization, theme, filtering, sorting, pagination, and model-price behavior.

The selected direction is **A: Data Command Center**. It uses a persistent desktop sidebar, a compact top action area, progressive-disclosure filters, a metrics-and-trend overview, and a unified data explorer.

## Goals

- Make the most important usage and cost information scannable in the first viewport.
- Give frequent operators a stable, high-density desktop workflow.
- Remove the current long vertical sequence of unrelated panels.
- Preserve every existing dashboard capability without backend changes.
- Provide deliberate tablet and mobile layouts rather than shrinking the desktop grid.
- Split the current monolithic page into focused React components without changing data ownership.

## Non-goals

- No new metrics, reports, APIs, database changes, routes, or permissions.
- No new authentication or session behavior.
- No changes to ingestion, pricing calculations, sorting semantics, or pagination semantics.
- No marketing content, onboarding flow, decorative illustration, or additional product claims.
- No client-side router is introduced; this remains one authenticated dashboard surface.

## Information Architecture

The authenticated surface has four vertical regions:

1. **App shell**: persistent desktop sidebar and main content canvas.
2. **Page header and filters**: page identity, update context, global actions, and progressive-disclosure filters.
3. **Overview**: five existing metrics and the existing usage trend chart.
4. **Data explorer**: existing Events, Devices, Projects, and Prices tabs and their current interactions.

The login screen retains its existing behavior and fields. Its spacing, typography, and controls will be aligned with the new command-center design system, but it is not restructured into a new authentication flow.

## Navigation Model

The sidebar is page-level navigation, not a duplicate of the data tabs:

- **Dashboard** moves focus to the metrics overview.
- **Usage trend** moves focus to the trend analysis region.
- **Data explorer** moves focus to the data explorer without changing the active data tab.
- **Model prices** moves focus to the data explorer and activates the Prices tab.

Events, Devices, Projects, and Prices remain tabs inside Data explorer. This preserves their current shared container and avoids introducing route state.

On desktop, sidebar selections scroll or focus the corresponding page section. On tablet, the sidebar collapses to an icon rail with accessible labels. On mobile, the sidebar becomes a top menu; selecting an item closes the menu before moving focus.

## Desktop Layout

At widths of 1024 px and above:

- A fixed-width sidebar occupies 200 px.
- The main canvas uses the remaining width with a 1440 px maximum content width and 24 px gutters.
- The page header places title and date/update context on the left and language, theme, refresh, account, and logout controls on the right.
- A compact filter toolbar follows the header.
- The overview uses a 1:2 column ratio: metric cards on the left and the trend chart on the right.
- Data explorer spans the full main-canvas width below the overview.

The five metric cards use the current values only: Total tokens, Input, Output, Cache read, and Cost. Total tokens receives the strongest emphasis; the remaining four form a balanced two-column grid.

## Filters

The always-visible desktop toolbar contains:

- Date range, represented by the existing From and To values as a grouped control.
- Tool.
- Model.
- Project.

The **More filters** disclosure contains:

- Device.
- Time zone.

Changing any filter continues to update the existing `UsageFilters` state and resets event pagination where the current implementation does so. The redesign does not add a separate apply transaction; the existing immediate refresh behavior is preserved. The disclosure only changes visibility, not data flow.

On mobile, the date range remains immediately available and the remaining filters open in a bottom-sheet-style panel. The panel uses the same native form controls and state as desktop.

## Overview and Trend

The overview is one cohesive region rather than two unrelated panel stacks.

- Metrics remain readable while data refreshes; existing values stay visible during background refresh.
- Initial loading uses size-stable skeletons to prevent layout shift.
- The trend panel retains Daily/Cumulative and All/Tokens/Cost controls.
- Theme-aware chart colors, axis formatting, cache aggregation, and cumulative calculations remain unchanged.
- At tablet and mobile widths, metrics appear before the chart in a single content column.

## Data Explorer

Data explorer retains the existing tabs and behaviors:

- **Events**: sort selector, previous/next pagination, and event table.
- **Devices**: registered devices and status display.
- **Projects**: project sort selector and project table.
- **Prices**: price form, edit, save, delete, and price table.

The desktop table remains table-driven and horizontally scrollable when needed. It is not converted into cards. Tab selection remains local React state, and selecting Model prices from the sidebar sets the same state to `prices`.

## Responsive Behavior

### Tablet: 641–1023 px

- Sidebar collapses to an icon rail.
- Header actions wrap into a second row when they no longer fit beside the page title.
- Filter toolbar uses two columns.
- Metrics and trend stack vertically.
- Data tables preserve minimum widths and scroll horizontally inside their container.

### Mobile: up to 640 px

- A compact top bar replaces the sidebar.
- Page navigation opens as a dismissible menu.
- Date range and filter trigger are the first controls.
- Metric cards use two columns where space permits; Total tokens spans both columns.
- Trend and Data explorer are single-column blocks.
- Data tabs remain horizontally scrollable.
- Every primary action, label, and value remains fully visible at 320 px viewport width.

## Visual System

- Keep the existing navy and cobalt product palette, with clearer contrast and less decorative glow.
- Keep light and dark themes; the sidebar uses a consistent branded navy surface in both.
- Use compact radii, quiet borders, restrained shadows, and deliberate spacing.
- Motion is limited to useful state transitions and respects `prefers-reduced-motion`.
- Remove hover movement that causes metric or panel geometry to shift.
- Use one consistent icon family with accessible text labels or `aria-label` values.
- Use code-native text and controls throughout; no raster image is required for the dashboard UI.

## Component Boundaries

The current page state and data orchestration remain in `App`. Render responsibilities move into focused components:

- `AppShell`: responsive sidebar/top-menu frame and main content slot.
- `SidebarNavigation`: page anchors, active-section indication, and Model prices activation.
- `DashboardHeader`: page context, language, theme, account, logout, and refresh actions.
- `FilterToolbar`: visible filters, More filters disclosure, and mobile filter panel.
- `MetricsOverview`: the five metric cards and initial-loading skeletons.
- `TrendPanel`: chart header, display controls, empty state, and chart surface.
- `DataExplorer`: tabs and active data panel.

Existing table and price-panel components can remain separate. Shared icon buttons and section headers should be small reusable primitives rather than duplicated inline SVG/button structures.

The split must not create new data-fetching effects. `App` continues to own authentication, filters, fetched dashboard data, refresh timing, errors, pagination, sorting, language, and theme state. Child components receive explicit values and callbacks.

## State and Data Flow

1. Authentication resolves exactly as it does today.
2. Authenticated `App` owns filters and dashboard data.
3. Filter changes update existing state and trigger existing refresh callbacks.
4. Overview and Data explorer receive the same fetched `DashboardData` slices as today.
5. Sidebar navigation changes focus/scroll position; only Model prices also changes the existing `activeTab` state.
6. Background summary refresh continues every 60 seconds without reloading tables.

No component introduces a second copy of server data or filter state.

## Loading, Empty, and Error States

- Session checking keeps a centered, branded status surface.
- Initial authenticated loading renders size-stable skeletons in metrics, trend, and data regions.
- Background refresh preserves current values and uses a non-blocking refresh indicator.
- The global fetch error appears immediately below the filter toolbar.
- Trend empty state stays inside the trend panel.
- Table empty states stay inside their respective table bodies.
- Form errors stay adjacent to the Prices form.
- Layout height and navigation must remain stable for all states.

## Accessibility

- Sidebar and mobile menu use semantic navigation landmarks.
- Page-anchor controls expose current/active state.
- Data explorer retains `tablist`, `tab`, and `aria-selected` semantics.
- More filters exposes `aria-expanded` and a controlled panel relationship.
- Mobile menu and filter panel return focus to their triggers when dismissed.
- All theme, refresh, navigation, and icon-only controls have localized accessible names.
- Keyboard users can reach every filter and data control in visual order.
- Color is not the only indicator for active, loading, error, or disabled states.

## Testing and Verification

Automated coverage will preserve the existing dashboard integration tests and add focused checks for:

- Sidebar navigation targets the correct section.
- Model prices navigation activates the Prices tab.
- More filters toggles visibility and accessibility state.
- Existing filters still issue the same query parameters.
- Existing tab, sorting, pagination, price, theme, and language behavior remains intact.
- Initial, background-refresh, error, and empty states render in the correct region.

Rendered QA will verify:

- Desktop at 1440 × 1000.
- Tablet near 900 × 1000.
- Mobile at 390 × 844 and the 320 px minimum width.
- Light and dark themes.
- Login, authenticated overview, each data tab, More filters, mobile navigation, loading, empty, and error states.
- No relevant console errors or framework overlays.

The accepted visual-companion mockups define layout direction and hierarchy. A production concept pass will finalize exact spacing, typography, icon treatment, and responsive details before implementation; it must not change the information architecture or interaction rules in this specification.

## Acceptance Criteria

- The authenticated first viewport visibly contains the filter toolbar, all five metrics, and the trend panel at 1440 × 1000.
- Sidebar navigation and Data explorer tabs have distinct responsibilities and do not conflict.
- All existing user-visible functionality and API behavior remains available.
- Layout is usable without clipping at 320 px width.
- Existing automated tests pass, and new navigation/filter-disclosure tests pass.
- Browser screenshots match the approved Data Command Center hierarchy in desktop, tablet, and mobile views.
- No backend, API, database, authentication, or permission code is changed.
