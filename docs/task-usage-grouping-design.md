# Task Usage Grouping Design

## Goal

Add a task-level view to Usage details without removing or changing the existing event view. Task totals must be computed from every matching event, not only the events on the current page.

## User Experience

Usage details gains a `Tasks` tab between `Events` and `Devices`. The complete tab order is:

1. Events
2. Tasks
3. Devices
4. Projects
5. Prices

The Tasks tab follows the existing table patterns for density, controls, pagination, and horizontal overflow. It shows:

- task ID
- first event time
- last activity time
- device
- project
- event count
- input tokens
- output tokens
- cache tokens
- total tokens
- cost

Task IDs use monospace text and may be visually shortened, while the full value remains available through a native tooltip. A task ID beginning with `fallback:` is labeled as a fallback task. If matching events for one task contain multiple device or project values, the corresponding cell displays `Multiple` instead of selecting an arbitrary value.

The initial release does not add task expansion, event drill-down, task naming, or navigation from a task to its events.

## Filtering, Sorting, and Pagination

Tasks use the same date range, reporting time zone, tool, device, project, and model filters as the rest of the dashboard. Filters apply to events before aggregation, so each task row describes the matching portion of that task inside the selected reporting scope.

Task pagination and sorting are independent from event pagination and sorting. Switching between Events and Tasks preserves both views' positions.

The default task sort is last activity time descending. The supported task sort keys are:

- last activity time
- event count
- total tokens
- cost

Every sort key supports ascending and descending order. Sorting happens before pagination and uses a stable task ID tie-breaker so page boundaries do not shift when aggregate values are equal.

## Server API

Add `GET /api/admin/tasks`. It accepts the existing usage filters plus:

- `limit`
- `offset`
- `sortBy`
- `sortDir`

The response shape is:

```json
{
  "rows": [
    {
      "taskId": "task-id",
      "isFallback": false,
      "startedAt": "2026-07-15T12:00:00.000Z",
      "lastActivityAt": "2026-07-15T12:15:00.000Z",
      "deviceId": "device-id-or-null",
      "deviceName": "Device name or null",
      "deviceCount": 1,
      "projectId": "project-id-or-null",
      "projectName": "Project name or null",
      "projectCount": 1,
      "eventCount": 3,
      "inputTokens": 100,
      "outputTokens": 20,
      "cacheReadTokens": 30,
      "cacheWriteTokens": 10,
      "totalTokens": 160,
      "costUsd": 0.0123
    }
  ],
  "total": 1
}
```

`total` is the number of distinct task IDs after filters are applied. Invalid pagination or sort parameters return the same `400 invalid filters` response used by the event endpoint.

## Query Design

The task query applies the shared event predicate first, groups matching rows by `usage_events.task_id`, computes aggregates, sorts the grouped rows, and only then applies limit and offset.

The query joins device and project metadata for display. A single distinct non-null device or project produces its ID, display name, and a count of one. More than one distinct value produces a count greater than one and null ID and name fields. No matching value produces a zero count and null fields. The frontend uses these counts to render translated `Multiple` or neutral placeholder labels, so the API does not embed locale-specific display text.

Fallback tasks remain grouped by their persisted task ID. Since fallback IDs are device-scoped (`fallback:<device-id>`), unattributed events from different devices cannot collapse into one task.

## Frontend Data Flow

The dashboard API client adds task row, task sort, and task page types and requests `/api/admin/tasks` in parallel with the existing dashboard endpoints. The application owns independent task offset and task sort state. Filter changes reset both event and task offsets to zero.

The Tasks table is a focused component with the same control and empty-state behavior as the Events table. It does not aggregate client-side and does not derive task totals from the event response.

## Internationalization and Accessibility

Add task-related strings to English, Chinese, Japanese, and Korean locale dictionaries. The Tasks control remains a semantic tab. Sort controls have visible labels, pagination has a task-specific accessible label, full task IDs are available without relying on truncated text, and the existing table keyboard and focus behavior is preserved.

## Error Handling

Task query failures use the dashboard's existing error banner and authentication handling. Empty results render a translated empty table row. Page navigation is disabled at the first and last pages using the server-provided total.

## Testing

Server tests cover:

- grouping all filtered events before pagination
- aggregate token, cost, and event totals
- date, tool, device, project, and model filters
- fallback task identification
- single versus multiple device and project display values
- every supported sort key in both directions
- stable task ID tie-breaking
- invalid route pagination and sort parameters

Frontend tests cover:

- the Tasks tab and tab order
- API query construction and response typing
- default and changed task sorting
- independent task pagination
- filter changes resetting task pagination
- fallback and multiple-value labels
- empty results
- translated labels in all supported locales

Final verification includes the full test suite, type checking, production build, open-source boundary check, and browser interaction checks for tab switching, sorting, pagination, and horizontal overflow.
