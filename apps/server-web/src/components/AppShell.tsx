import { type ReactNode, useCallback, useState } from "react";
import type {
  DashboardSection,
  LanguageSetting,
  Theme,
  Translate
} from "../dashboard-types.js";
import { DashboardIcon, type DashboardIconName } from "./DashboardIcons.js";

type AppShellProps = {
  activeSection: DashboardSection;
  adminEmail: string;
  children: ReactNode;
  currentTimeLabel: string;
  languageSetting: LanguageSetting;
  loading: boolean;
  theme: Theme;
  t: Translate;
  onLanguageChange: (value: LanguageSetting) => void;
  onLogout: () => void;
  onNavigate: (section: DashboardSection) => void;
  onOpenPrices: () => void;
  onRefresh: () => void;
  onThemeToggle: () => void;
};

const languageOptions: Array<{ value: LanguageSetting; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },
  { value: "en", label: "English" },
  { value: "ko", label: "Korean" }
];

const navigationItems: Array<{
  icon: DashboardIconName;
  label: string;
  section?: DashboardSection;
  prices?: boolean;
}> = [
  { icon: "dashboard", label: "Dashboard", section: "overview" },
  { icon: "trend", label: "Usage trend", section: "trend" },
  { icon: "explorer", label: "Data explorer", section: "explorer" },
  { icon: "prices", label: "Model prices", prices: true }
];

export function AppShell({
  activeSection,
  adminEmail,
  children,
  currentTimeLabel,
  languageSetting,
  loading,
  theme,
  t,
  onLanguageChange,
  onLogout,
  onNavigate,
  onOpenPrices,
  onRefresh,
  onThemeToggle
}: AppShellProps) {
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);

  const handleNavigation = useCallback(
    (section: DashboardSection) => {
      onNavigate(section);
      setMobileNavigationOpen(false);
    },
    [onNavigate]
  );

  const handlePrices = useCallback(() => {
    onOpenPrices();
    setMobileNavigationOpen(false);
  }, [onOpenPrices]);

  return (
    <div className="dashboard-shell command-center-shell">
      <button
        aria-label={t(mobileNavigationOpen ? "Close navigation" : "Open navigation")}
        aria-expanded={mobileNavigationOpen}
        className="mobile-navigation-trigger"
        onClick={() => setMobileNavigationOpen((open) => !open)}
        type="button"
      >
        <DashboardIcon name={mobileNavigationOpen ? "close" : "menu"} />
      </button>
      <div className="mobile-brand-bar" aria-hidden="true">
        <span className="dashboard-brand-mark">C</span>
        <span>Codex Usage</span>
      </div>

      <aside className="dashboard-sidebar">
        <div className="dashboard-brand" aria-label="Codex Usage Dashboard">
          <span className="dashboard-brand-mark">C</span>
          <span>Codex Usage</span>
        </div>
        <nav
          aria-label="Dashboard navigation"
          className="dashboard-navigation"
          data-mobile-open={String(mobileNavigationOpen)}
        >
          {navigationItems.map((item) => {
            const active = item.section ? activeSection === item.section : false;
            return (
              <button
                aria-current={active ? "page" : undefined}
                className={active ? "dashboard-nav-item active" : "dashboard-nav-item"}
                key={item.label}
                onClick={() => (item.prices ? handlePrices() : handleNavigation(item.section!))}
                type="button"
              >
                <DashboardIcon name={item.icon} />
                <span>{t(item.label)}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="app-shell dashboard-main command-center-main">
        <header className="topbar command-center-header">
          <div className="command-center-title">
            <h1>{t("Codex Usage Dashboard")}</h1>
            <p className="utc-clock" aria-label={t("Current UTC time")}>
              {currentTimeLabel}
            </p>
          </div>
          <div className="topbar-actions">
            <label className="language-select">
              <span>{t("Language")}</span>
              <select
                aria-label={t("Language")}
                onChange={(event) => onLanguageChange(event.target.value as LanguageSetting)}
                value={languageSetting}
              >
                {languageOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.label)}
                  </option>
                ))}
              </select>
            </label>
            <button
              aria-label="Toggle Theme"
              className="theme-toggle-button"
              onClick={onThemeToggle}
              type="button"
            >
              <DashboardIcon name={theme === "light" ? "moon" : "sun"} size={18} />
            </button>
            <span className="admin-chip">{adminEmail}</span>
            <button className="secondary-button" disabled={loading} onClick={onLogout} type="button">
              {t("Logout")}
            </button>
            <button className="primary-button" disabled={loading} onClick={onRefresh} type="button">
              <DashboardIcon name="refresh" size={17} />
              {loading ? t("Refreshing...") : t("Refresh")}
            </button>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}
