import type { TaskUsage } from "../api.js";
import type { TaskSort, Translate } from "../dashboard-types.js";

type TasksTableProps = {
  rows: TaskUsage[];
  total: number;
  limit: number;
  offset: number;
  sort: TaskSort;
  onSortChange: (sort: TaskSort) => void;
  onPrevious: () => void;
  onNext: () => void;
  t: Translate;
};

export function TasksTable({
  rows,
  total,
  limit,
  offset,
  sort,
  onSortChange,
  onPrevious,
  onNext,
  t
}: TasksTableProps) {
  const pageEnd = Math.min(offset + limit, total);

  return (
    <>
      <div className="panel-header">
        <h2>{t("Tasks")}</h2>
        <span>{`${formatNumber(total)} ${t("total")}`}</span>
      </div>
      <div className="table-controls">
        <label>
          {t("Sort")}
          <select value={sort} onChange={(event) => onSortChange(event.target.value as TaskSort)}>
            <option value="lastActivityAt-desc">{t("Last activity newest first")}</option>
            <option value="lastActivityAt-asc">{t("Last activity oldest first")}</option>
            <option value="eventCount-desc">{t("Events high to low")}</option>
            <option value="eventCount-asc">{t("Events low to high")}</option>
            <option value="totalTokens-desc">{t("Total tokens high to low")}</option>
            <option value="totalTokens-asc">{t("Total tokens low to high")}</option>
            <option value="costUsd-desc">{t("Cost high to low")}</option>
            <option value="costUsd-asc">{t("Cost low to high")}</option>
          </select>
        </label>
        <div className="pagination-controls" aria-label={t("Task pagination")}>
          <button type="button" className="secondary-button" onClick={onPrevious} disabled={offset === 0}>
            {t("Previous")}
          </button>
          <span>
            {total === 0
              ? `0 ${t("of")} 0`
              : `${formatNumber(offset + 1)}-${formatNumber(pageEnd)} ${t("of")} ${formatNumber(total)}`}
          </span>
          <button type="button" className="secondary-button" onClick={onNext} disabled={offset + limit >= total}>
            {t("Next")}
          </button>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("Task")}</th>
              <th>{t("Started")}</th>
              <th>{t("Last activity")}</th>
              <th>{t("Device")}</th>
              <th>{t("Project")}</th>
              <th className="numeric">{t("Events")}</th>
              <th className="numeric">{t("Input")}</th>
              <th className="numeric">{t("Output")}</th>
              <th className="numeric">{t("Cache")}</th>
              <th className="numeric">{t("Total tokens")}</th>
              <th className="numeric">{t("Cost")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.taskId}>
                <td className="mono" title={row.taskId}>
                  {row.isFallback ? <span className="status fallback">{t("Fallback")}</span> : null}
                  {row.isFallback ? " " : null}
                  <span>{row.taskId}</span>
                </td>
                <td>{formatDateTime(row.startedAt)}</td>
                <td>{formatDateTime(row.lastActivityAt)}</td>
                <td>{groupLabel(row.deviceName, row.deviceCount, t)}</td>
                <td>{groupLabel(row.projectName, row.projectCount, t)}</td>
                <td className="numeric">{formatNumber(row.eventCount)}</td>
                <td className="numeric">{formatNumber(row.inputTokens)}</td>
                <td className="numeric">{formatNumber(row.outputTokens)}</td>
                <td className="numeric">{formatNumber(row.cacheReadTokens + row.cacheWriteTokens)}</td>
                <td className="numeric strong">{formatNumber(row.totalTokens)}</td>
                <td className="numeric strong">{formatCurrency(row.costUsd)}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td className="empty-cell" colSpan={11}>{t("No tasks in this range")}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function groupLabel(name: string | null, count: number, t: Translate): string {
  if (count > 1) return `${t("Multiple")} (${formatNumber(count)})`;
  return name ?? t("Unknown");
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute} UTC`;
}
