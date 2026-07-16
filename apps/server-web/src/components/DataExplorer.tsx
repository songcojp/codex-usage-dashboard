import type { ReactNode } from "react";
import type { DashboardTab, Translate } from "../dashboard-types.js";

type DataExplorerProps = {
  activeTab: DashboardTab;
  priceError?: string | null;
  t: Translate;
  onTabChange: (tab: DashboardTab) => void;
  renderPanel: (tab: DashboardTab) => ReactNode;
};

const tabs: DashboardTab[] = ["tasks", "events", "devices", "projects", "prices"];

export function DataExplorer({
  activeTab,
  priceError,
  t,
  onTabChange,
  renderPanel
}: DataExplorerProps) {
  return (
    <div className="panel data-explorer">
      <div className="data-explorer-heading">
        <div>
          <p className="section-kicker">{t("Data explorer")}</p>
          <h2>{t("Usage details")}</h2>
        </div>
      </div>
      <div className="tab-row" role="tablist" aria-label={t("Details")}>
        {tabs.map((tab) => {
          const label = tab[0].toUpperCase() + tab.slice(1);
          return (
            <button
              aria-controls={`data-panel-${tab}`}
              aria-selected={activeTab === tab}
              className={activeTab === tab ? "tab-button active" : "tab-button"}
              id={`data-tab-${tab}`}
              key={tab}
              onClick={() => onTabChange(tab)}
              role="tab"
              type="button"
            >
              {t(label)}
            </button>
          );
        })}
      </div>
      <div
        aria-labelledby={`data-tab-${activeTab}`}
        className="data-explorer-panel"
        id={`data-panel-${activeTab}`}
        role="tabpanel"
      >
        {activeTab === "prices" && priceError ? <div role="alert" className="error-banner compact">{priceError}</div> : null}
        {renderPanel(activeTab)}
      </div>
    </div>
  );
}
