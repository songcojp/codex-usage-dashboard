# Dashboard Command Center Visual System

## Accepted concepts

- Desktop reference: `docs/superpowers/concepts/dashboard-command-center-desktop.png` (1505 × 1045 generated reference for the 1440 × 1000 target viewport).
- Mobile reference: `docs/superpowers/concepts/dashboard-command-center-mobile.png` (852 × 1846 generated reference for the 390 × 844 target viewport).

Both concepts were generated with the built-in Image Gen path and approved by the user on 2026-07-14. They are visual specifications only. The shipped interface remains code-native React, HTML, CSS, SVG, and ECharts.

## Color lock

- Canvas: cool gray `#f5f7fa`; never cream, beige, or warm white.
- Surface: true white `#ffffff`.
- Sidebar and primary metric: deep navy `#07182f`, using `#0d213f` for raised/hover states.
- Primary action and selected state: cobalt `#1760ff`; hover `#0d4ee8`; subtle selected background `#eaf1ff`.
- Primary text: ink navy `#0b1830`.
- Secondary text: slate `#526077`.
- Muted text: `#7c899d`.
- Border: cool blue-gray `#d9e1eb`; subtle divider `#e8edf3`.
- Positive: `#4aa23f`; cost accent: `#ef8b00`; output accent: `#7951f5`; cache/chart accent: `#1fa5c4`.
- Dark theme keeps the same sidebar, cobalt, and semantic accents while mapping canvas/surfaces/text through the existing dark theme tokens.

## Typography

- Family: `Inter, "Segoe UI", ui-sans-serif, system-ui, -apple-system, sans-serif`.
- Page title: 24 px desktop / 22 px mobile, 750 weight, 1.2 line height, `-0.025em` tracking.
- Section title: 16 px, 750 weight, 1.3 line height.
- Primary metric value: 34 px desktop / 30 px mobile, 750 weight, tabular figures.
- Supporting metric value: 24 px desktop / 22 px mobile, 700 weight, tabular figures.
- Body/table: 13 px desktop, 12 px compact/mobile, 1.45 line height.
- Labels/control chrome: 12 px, 650 weight; captions: 11 px, 550 weight.
- Buttons, selects, tabs, sidebar rows, and table controls receive explicit sizes; none rely on browser defaults.

## Spacing and geometry

- Spacing scale: 4, 8, 12, 16, 20, 24, 32 px.
- Desktop sidebar: 200 px fixed width.
- Desktop main canvas: 1440 px maximum content width with 24 px gutters.
- Desktop overview: metrics/trend columns at 1:2 with 12 px gap.
- Panel radius: 10 px; control radius: 7 px; selected sidebar radius: 6 px.
- Panel border: 1 px solid border token.
- Panel shadow: `0 2px 8px rgba(7, 24, 47, 0.04)`; no floating-card shadow stacks.
- Header height is content-driven and compact; sidebar spans viewport height and remains sticky.
- Mobile top bar: 64 px; mobile content gutters: 14 px; overview becomes a single column.
- Total tokens spans the full metric width; four supporting metrics use two columns down to 360 px and one column at the 320 px minimum when needed to prevent clipping.

## Container model

- One shell grid, one sidebar rail, open main canvas.
- Filters, metric cards, trend, and Data explorer use separate thin-bordered surfaces.
- Do not wrap the entire main canvas in another rounded container.
- Do not convert the Data explorer table to cards. Preserve horizontal scrolling inside the table wrapper.
- Mobile uses a top navigation bar and an overlay menu; filters use a dismissible panel. Neither overlay changes the underlying data state.

## Icon inventory

- Style: 2 px outline, round caps and joins, `currentColor`, 24 × 24 viewBox.
- Sidebar: dashboard/bar chart, trend line, database/data explorer, price tag.
- Header: language/globe, sun/moon, account, logout, refresh, menu/close.
- Filters: calendar, filter/funnel, disclosure chevron.
- Metrics: compact 32–40 px tinted icon containers matching the concept.
- Icon-only controls require localized accessible names; decorative SVGs use `aria-hidden="true"`.

## Component families

- Sidebar row: icon + label, 40 px target; selected row uses cobalt fill and white content.
- Primary button: cobalt fill, white 12–13 px semibold label, 36–40 px height.
- Secondary control: white surface, border token, ink/slate content, 36–40 px height.
- Filters: label above a native field; desktop fields share one toolbar surface.
- Metrics: one navy primary variant and one white supporting variant; no geometry-changing hover movement.
- Segmented chart controls: outlined group with cobalt selected text/border and white selected surface.
- Tabs: open underline navigation, not pills.
- Tables: white rows, quiet dividers, compact headers, tabular numeric columns, contained horizontal scrolling.
- Loading: size-stable skeletons that preserve the accepted panel geometry.
- Errors: global alert below filters; price mutation alert inside the Prices form.

## Responsive continuation

- Desktop (1024 px and above): full sidebar, compact one-line primary filters, metrics and chart side by side.
- Tablet (641–1023 px): icon rail, wrapping header actions, two-column filters, metrics and chart stacked.
- Mobile (640 px and below): navy top bar with menu, date range plus filter trigger, metric grid, chart, then Data explorer.
- Minimum width (320 px): no clipped action, label, metric, or table container; controls may stack and tables scroll internally.

## Allowed first-viewport copy

Static labels are limited to existing localized product strings plus the approved navigation/filter additions: Codex Usage Dashboard, Dashboard, Usage trend, Data explorer, Model prices, From, To, Tool, Model, Project, More filters, Total tokens, Input, Output, Cache read, Cost, Daily, Cumulative, All, Tokens, Events, Devices, Projects, Prices, Refresh, Logout, Language, and Time zone.

Dates, timezone, account email, metric values, model names, tool names, projects, and event rows remain dynamic production data. The generated references' sample values and the name "Jane Doe" are not shipped copy.

## Motion

- 160–220 ms color, border, shadow, and overlay transitions.
- Sidebar scrolling uses the browser's smooth-scroll behavior unless reduced motion is requested.
- Metric digit transitions may remain but must not move surrounding layout.
- `prefers-reduced-motion: reduce` disables nonessential animation and smooth scrolling.
