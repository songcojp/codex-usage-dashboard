# Usage Ratios and Project Share Design

## Goal

Correct the meaning and calculation of the recently added ratio views, rename the mislabeled application view to a tool view, and add project Token share reporting with distinct daily and all-time semantics.

## Confirmed Product Semantics

### Tool share

- Rename `App ratio` to `Tool ratio` in the UI and all supported locales.
- A tool's share is its `totalTokens` divided by the combined `totalTokens` of all visible tools.
- Daily mode calculates the share independently for each day in the selected date range.
- Cumulative mode calculates the share from the beginning of the selected date range through each displayed day.
- Tool share remains a trend view.

### Token type share

- The categories are input, output, and cache.
- Cache combines cache-read and cache-write Tokens.
- The denominator is input + output + cache-read + cache-write Tokens. These values are stored as mutually exclusive categories by the current ingestion parsers.
- Daily and cumulative modes continue to use the selected date range.

### Cost share

- The categories are input cost, output cost, and cache cost.
- Cache cost combines cache-read and cache-write cost.
- The denominator is the sum of those three cost categories.
- Daily and cumulative modes continue to use the selected date range.

### Project share

- Add `Project ratio` as a separate chart filter.
- Daily mode calculates each project's Token share independently for every day in the selected date range and renders a multi-series line chart.
- When project share is selected, the second mode button is labeled `Total` instead of `Cumulative`.
- Total mode ignores the selected date range and calculates each project's share from all usage recorded up to the current moment. It renders a pie chart because this result is a current distribution, not a trend.
- Project share always ignores the selected project filter so that all projects remain comparable.
- Tool, device, and model filters still apply in both project modes.
- The selected reporting time zone controls daily boundaries. It does not constrain the all-time total.
- Project records with the same repository hash are merged, matching the existing project table behavior. Records without a repository hash remain distinct by project ID.

## Backend Design

Add an authenticated `GET /api/admin/project-ratios` endpoint. It accepts the existing `from`, `to`, `timeZone`, `tool`, `deviceId`, and `model` query parameters. It does not accept or apply `projectId`.

The response contains both datasets needed by the UI:

```ts
type ProjectRatioResponse = {
  daily: Array<{
    day: string;
    projects: Array<{
      projectKey: string;
      projectName: string;
      totalTokens: number;
    }>;
  }>;
  total: Array<{
    projectKey: string;
    projectName: string;
    totalTokens: number;
  }>;
};
```

The daily query applies the date range and reporting time zone. The total query deliberately omits date predicates. Both queries apply tool, device, and model filters. Both aggregate by project before merging repository-equivalent records.

The existing trend response continues to carry per-day tool usage and cost components. Tool share changes from cost-based calculation to Token-based calculation in the web chart layer.

## Frontend Design

- Extend the dashboard API result with `projectRatios` and fetch it alongside the existing dashboard requests.
- Extend the trend filter union with `tool-ratio` and `project-ratio`; remove `app-ratio`.
- Keep line charts for tool, Token type, cost, and daily project ratios.
- Register the ECharts pie chart renderer and use it only for total project share.
- Daily project series use the union of all projects in the returned date range. A project without usage on a day has a zero value for that day.
- Percentages are calculated from raw Token totals in the chart data transformation, rounded to one decimal place for display.
- Total project pie slices include every project with positive Token usage. The legend uses scrolling behavior when the project count exceeds the available width.
- Empty daily and total project datasets render localized no-data labels instead of misleading zero-valued project series.

## Data Accuracy Rules

- The server returns raw aggregates; the client derives percentages from a single denominator per day or total snapshot.
- Tool share uses Tokens, not cost.
- Missing series values are treated as zero, but missing projects are not included in denominators.
- A non-zero distribution should total approximately 100%, allowing only the visible one-decimal rounding error.
- Source `points` and API response objects must not be mutated while deriving cumulative or ratio data.

## Localization

Add or update the following English keys and their Chinese, Japanese, and Korean translations:

- `Tool ratio`
- `Project ratio`
- `Total`
- `No tools`
- `No project usage`

Remove UI use of `App ratio` and `No applications`. Existing unused translation entries may be deleted.

## Error Handling

- A project-ratio request failure follows the dashboard's existing authenticated request and error handling path.
- Empty successful datasets are normal and render no-data states.
- Zero denominators produce zero percentages and never `NaN` or infinity.

## Test Coverage

### Server

- Route parsing excludes `projectId` and accepts the supported filters.
- Daily aggregation respects the selected time zone and date range.
- Total aggregation ignores the date range.
- Tool, device, and model filters affect both datasets.
- Same-repository project records merge while unrelated projects remain separate.

### Web API

- The dashboard requests the project-ratio endpoint with date, time-zone, tool, device, and model filters but without `projectId`.

### Chart transformation and UI

- Tool share is calculated from `totalTokens`, not `costUsd`.
- The tool title is localized as tool share.
- Daily project shares are calculated per day and missing project days become zero.
- Total project shares use the all-time dataset and render as a pie chart.
- Project mode changes the second mode label to `Total` while other filters retain `Cumulative`.
- Zero and empty datasets remain finite and show the correct no-data label.
- Input props remain unchanged.

## Out of Scope

- Changing stored historical event costs or repricing past events.
- Adding project ranking limits or grouping small projects into an `Other` slice.
- Changing the existing project identity and repository-hash merge policy.
- Adding new date controls specifically for project total mode.
