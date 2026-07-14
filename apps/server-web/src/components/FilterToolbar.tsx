import { useState } from "react";
import type { UsageFilters } from "../api.js";
import type { Translate } from "../dashboard-types.js";
import { DashboardIcon } from "./DashboardIcons.js";

type FilterOption = { id: string; name: string };
type ProjectOption = { id: string; displayName: string };
type ToolOption = { id: string; slug: string; displayName: string };
type TimeZoneOption = { value: string; label: string };

type FilterToolbarProps = {
  deviceOptions: FilterOption[];
  filters: UsageFilters;
  modelOptions: string[];
  projectOptions: ProjectOption[];
  toolOptions: ToolOption[];
  timeZoneOptions: TimeZoneOption[];
  t: Translate;
  onChange: <K extends keyof UsageFilters>(key: K, value: UsageFilters[K]) => void;
};

export function FilterToolbar({
  deviceOptions,
  filters,
  modelOptions,
  projectOptions,
  toolOptions,
  timeZoneOptions,
  t,
  onChange
}: FilterToolbarProps) {
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);

  return (
    <section
      className="filter-toolbar"
      aria-label={t("Dashboard filters")}
      data-expanded={String(moreFiltersOpen)}
    >
      <div className="filter-toolbar-primary">
        <fieldset className="date-range-group">
          <legend>{t("Date range")}</legend>
          <label>
            <span>{t("From")}</span>
            <input
              type="date"
              value={filters.from}
              onChange={(event) => onChange("from", event.target.value)}
            />
          </label>
          <label>
            <span>{t("To")}</span>
            <input type="date" value={filters.to} onChange={(event) => onChange("to", event.target.value)} />
          </label>
        </fieldset>
        <label>
          <span>{t("Time zone")}</span>
          <select value={filters.timeZone} onChange={(event) => onChange("timeZone", event.target.value)}>
            {timeZoneOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("Project")}</span>
          <select
            value={filters.projectId ?? ""}
            onChange={(event) => onChange("projectId", event.target.value || undefined)}
          >
            <option value="">{t("All projects")}</option>
            {projectOptions.map((project) => (
              <option key={project.id} value={project.id}>
                {project.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("Tool")}</span>
          <select
            value={filters.tool ?? ""}
            onChange={(event) => onChange("tool", event.target.value || undefined)}
          >
            <option value="">{t("All tools")}</option>
            {toolOptions.map((tool) => (
              <option key={tool.id} value={tool.slug}>
                {tool.displayName}
              </option>
            ))}
          </select>
        </label>
        <button
          aria-label={t(moreFiltersOpen ? "Close filters" : "More filters")}
          aria-controls="dashboard-more-filters"
          aria-expanded={moreFiltersOpen}
          className="more-filters-button"
          onClick={() => setMoreFiltersOpen((open) => !open)}
          type="button"
        >
          <DashboardIcon name={moreFiltersOpen ? "close" : "more"} size={18} />
          <span className="filters-label-default">{t(moreFiltersOpen ? "Close filters" : "More filters")}</span>
          <span className="filters-label-mobile">{t(moreFiltersOpen ? "Close filters" : "Filters")}</span>
        </button>
      </div>

      {moreFiltersOpen ? (
        <div className="mobile-filter-panel filter-toolbar-secondary" id="dashboard-more-filters">
          <label>
            <span>{t("Device")}</span>
            <select
              value={filters.deviceId ?? ""}
              onChange={(event) => onChange("deviceId", event.target.value || undefined)}
            >
              <option value="">{t("All devices")}</option>
              {deviceOptions.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("Model")}</span>
            <select
              value={filters.model ?? ""}
              onChange={(event) => onChange("model", event.target.value || undefined)}
            >
              <option value="">{t("All models")}</option>
              {modelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
    </section>
  );
}
