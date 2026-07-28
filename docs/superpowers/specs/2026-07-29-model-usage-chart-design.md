# Model Usage Chart Design

## Goal

Add a model-focused view to the usage trend panel so administrators can compare Token consumption across models over time and across the selected reporting range.

## User experience

The trend filter gains a **Model** option.

- In **Daily** mode, the chart renders one line per model. Each point is that model's total Token usage for the day. The tooltip shows the model name, Token count, and its percentage of all model Token usage for that day.
- In **Total** mode, the chart renders a donut chart. Each slice represents one model's total Token usage over the selected date range. The tooltip shows the model name, Token count, and percentage of the selected range's total.
- When Model is selected, the panel heading is **Model usage** and the mode control reads **Daily / Total**.
- When no model data exists, the panel shows **No model usage**.

Token usage means the stored `totalTokens` value. Counts use the dashboard's locale-aware integer formatting, and percentages use one decimal place.

## Filter behavior

Model aggregation respects the selected date range, reporting time zone, tool, device, and project filters.

The currently selected model filter is intentionally omitted from the model-usage aggregation request. This preserves a meaningful comparison among models even when the rest of the dashboard is filtered to one model, matching the existing project-ratio behavior that omits its own project filter.

## Data contract

Add an authenticated `GET /api/admin/model-ratios` endpoint with the following response shape:

```ts
type ModelRatioResponse = {
  daily: Array<{
    day: string;
    models: Array<{
      model: string;
      totalTokens: number;
    }>;
  }>;
  total: Array<{
    model: string;
    totalTokens: number;
  }>;
};
```

Null model values are grouped under `unknown`, consistent with existing model lists and event display.

The dashboard data loader requests this endpoint alongside trends and project ratios. It removes only the `model` filter from this request and passes the returned data into the trend panel.

## Server implementation

The admin query service adds one model-aggregation operation:

- The daily query groups usage events by reporting-zone day and normalized model.
- The total query groups the same filtered events by normalized model.
- Both queries sum `usage_events.total_tokens` without discarding rows during aggregation; presentation filters zero-value slices where necessary.
- Existing usage-filter validation and admin authentication are reused.

The response builder returns stable model ordering so chart legends and colors do not jump between requests.

## Chart implementation

The trend panel adds a `model` filter value and receives `ModelRatioResponse`.

Daily mode builds the union of model names across all returned days. Each model becomes a line series containing raw Token counts, with zero inserted for days where that model has no usage. A custom axis tooltip calculates each series' share using the total across models for that day.

Total mode builds a donut series from positive model totals. ECharts receives raw Token counts so its slice percentages remain accurate. The item tooltip formats both the localized count and the ECharts-calculated percentage.

The chart's data-presence check uses model-ratio data when the Model view is selected, rather than the generic trend points.

## Localization

Add translations for:

- Model
- Model usage
- No model usage

The existing Daily and Total translations are reused. Tooltip punctuation and numeric output follow existing chart conventions.

## Testing

Implementation follows test-first development.

- Query integration tests prove daily and total Token aggregation, `unknown` normalization, filter behavior, and stable response shape.
- Route tests prove authentication, filter parsing, and delegation to the model-aggregation query.
- Web API tests prove the model-ratios request omits only the model filter.
- Trend panel tests prove the Model control, Daily / Total labels, daily raw Token series with missing-day zeroes, daily count-and-percentage tooltip output, total donut data, and total tooltip formatting.
- Locale tests prove all supported languages include the new visible strings.
- Existing server and web test suites, type checks, and a production build provide regression coverage.

## Scope boundaries

This change does not add cost-by-model charts, event-count charts, model grouping or aliases, top-N collapsing, or changes to ingestion. It does not alter the existing project, tool, Token-type, or cost views.
