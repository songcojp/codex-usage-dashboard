import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { type ECharts, init, use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import {
  FormEvent,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  ApiError,
  deleteModelPrice,
  getDashboardData,
  getSession,
  getUsageSummary,
  login,
  logout,
  saveModelPrice,
  type DashboardData,
  type Device,
  type EventSortBy,
  type ModelPrice,
  type ModelPriceInput,
  type Project,
  type ProjectSortBy,
  type SortDir,
  type TaskSortBy,
  type TrendPoint,
  type UsageEvent,
  type UsageFilters
} from "./api.js";
import { AppShell } from "./components/AppShell.js";
import { DataExplorer } from "./components/DataExplorer.js";
import { FilterToolbar } from "./components/FilterToolbar.js";
import { MetricsOverview } from "./components/MetricsOverview.js";
import { TrendPanel } from "./components/TrendPanel.js";
import { TasksTable } from "./components/TasksTable.js";
import type {
  DashboardSection,
  DashboardTab as Tab,
  EventSort,
  Language,
  LanguageSetting,
  PriceDraft,
  ProjectSort,
  TaskSort,
  Theme
} from "./dashboard-types.js";
import { translations } from "./locales/index.js";

type AuthState = "checking" | "authenticated" | "anonymous";

const eventPageLimit = 25;
const taskPageLimit = 25;
const emptyPriceDraft: PriceDraft = {
  model: "",
  inputCostPerMillionUsd: "0",
  outputCostPerMillionUsd: "0",
  cacheReadCostPerMillionUsd: "0",
  cacheWriteCostPerMillionUsd: "0"
};
const defaultReportingTimeZone = "Asia/Tokyo";
const reportingTimeZoneOptions = [
  { value: "Asia/Tokyo", label: "Japan" },
  { value: "UTC", label: "UTC" },
  { value: "Asia/Shanghai", label: "China" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Paris", label: "Paris" },
  { value: "America/New_York", label: "New York" },
  { value: "America/Los_Angeles", label: "Los Angeles" }
];

const numberFormatter = new Intl.NumberFormat();
const languageLocales: Record<Language, string> = {
  zh: "zh-CN",
  ja: "ja-JP",
  en: "en-US",
  ko: "ko-KR"
};
const languageStorageKey = "codex-usage-dashboard-language";
const languageOptions: Array<{ value: LanguageSetting; labelKey: string }> = [
  { value: "auto", labelKey: "Auto" },
  { value: "zh", labelKey: "Chinese" },
  { value: "ja", labelKey: "Japanese" },
  { value: "en", labelKey: "English" },
  { value: "ko", labelKey: "Korean" }
];

use([GridComponent, LegendComponent, LineChart, TooltipComponent, CanvasRenderer]);

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [languageSetting, setLanguageSetting] = useState<LanguageSetting>(() => readStoredLanguageSetting());
  const [adminEmail, setAdminEmail] = useState("");
  const [utcNow, setUtcNow] = useState(() => new Date());
  const [filters, setFilters] = useState<UsageFilters>(() => defaultFilters());
  const [data, setData] = useState<DashboardData | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("events");
  const [activeSection, setActiveSection] = useState<DashboardSection>("overview");
  const [eventOffset, setEventOffset] = useState(0);
  const [eventSort, setEventSort] = useState<EventSort>("occurredAt-desc");
  const [taskOffset, setTaskOffset] = useState(0);
  const [taskSort, setTaskSort] = useState<TaskSort>("lastActivityAt-desc");
  const [projectSort, setProjectSort] = useState<ProjectSort>("updatedAt-desc");
  const [priceDraft, setPriceDraft] = useState<PriceDraft>(emptyPriceDraft);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);

  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem("codex-dashboard-theme");
      if (stored === "light" || stored === "dark") return stored;
      if (typeof window.matchMedia === "function") {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
    }
    return "light";
  });
  const overviewRef = useRef<HTMLElement>(null);
  const trendRef = useRef<HTMLElement>(null);
  const explorerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("codex-dashboard-theme", theme);
  }, [theme]);

  const from = filters.from;
  const to = filters.to;
  const tool = filters.tool;
  const deviceId = filters.deviceId;
  const projectId = filters.projectId;
  const model = filters.model;
  const timeZone = filters.timeZone;
  const modelOptions = useMemo(() => deriveModelOptions(data), [data]);
  const language = resolveLanguageSetting(languageSetting, getBrowserLanguages());
  const t = useCallback((key: string) => translate(language, key), [language]);

  const handleLanguageChange = useCallback((nextSetting: LanguageSetting) => {
    setLanguageSetting(nextSetting);
    writeStoredLanguageSetting(nextSetting);
  }, []);

  const handleNavigate = useCallback((section: DashboardSection) => {
    setActiveSection(section);
    const target = {
      overview: overviewRef.current,
      trend: trendRef.current,
      explorer: explorerRef.current
    }[section];
    target?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    target?.focus({ preventScroll: true });
  }, []);

  const handleOpenPrices = useCallback(() => {
    setActiveTab("prices");
    handleNavigate("explorer");
  }, [handleNavigate]);

  useEffect(() => {
    const interval = window.setInterval(() => setUtcNow(new Date()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!data) {
      return;
    }
    setPriceDraft((current) => {
      if (current.model) {
        return current;
      }
      return data.modelPrices.rows[0] ? draftFromPrice(data.modelPrices.rows[0]) : current;
    });
  }, [data]);

  const clearAuth = useCallback(() => {
    setData(null);
    setAdminEmail("");
    setError(null);
    setAuthState("anonymous");
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } finally {
      clearAuth();
    }
  }, [clearAuth]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextData = await getDashboardData(
        { from, to, tool, deviceId, projectId, model, timeZone },
        { limit: eventPageLimit, offset: eventOffset, ...eventSortToRequest(eventSort) },
        projectSortToRequest(projectSort),
        { limit: taskPageLimit, offset: taskOffset, ...taskSortToRequest(taskSort) }
      );
      setData(nextData);
    } catch (caught) {
      if (isUnauthorized(caught)) {
        clearAuth();
        return;
      }
      const message = caught instanceof Error ? caught.message : t("Failed to load dashboard");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [clearAuth, deviceId, eventOffset, eventSort, from, model, projectId, projectSort, t, taskOffset, taskSort, timeZone, to, tool]);

  const refreshSummary = useCallback(async () => {
    try {
      const nextSummary = await getUsageSummary({ from, to, tool, deviceId, projectId, model, timeZone });
      setData((current) => (current ? { ...current, summary: nextSummary } : current));
    } catch (caught) {
      if (isUnauthorized(caught)) {
        clearAuth();
        return;
      }
      const message = caught instanceof Error ? caught.message : t("Failed to load dashboard");
      setError(message);
    }
  }, [clearAuth, deviceId, from, model, projectId, t, timeZone, to, tool]);

  const handleSavePrice = useCallback(async () => {
    setLoading(true);
    setPriceError(null);
    try {
      await saveModelPrice(priceDraftToInput(priceDraft));
      await refresh();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("Failed to save model price");
      setPriceError(message);
    } finally {
      setLoading(false);
    }
  }, [priceDraft, refresh, t]);

  const handleDeletePrice = useCallback(
    async (id: string) => {
      setLoading(true);
      setPriceError(null);
      try {
        await deleteModelPrice(id);
        setPriceDraft(emptyPriceDraft);
        await refresh();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : t("Failed to delete model price");
        setPriceError(message);
      } finally {
        setLoading(false);
      }
    },
    [refresh, t]
  );

  useEffect(() => {
    let cancelled = false;

    getSession()
      .then((session) => {
        if (cancelled) return;
        setAdminEmail(session.email);
        setAuthState("authenticated");
      })
      .catch((caught) => {
        if (cancelled) return;
        if (isUnauthorized(caught)) {
          clearAuth();
          return;
        }
        setAuthState("anonymous");
      });

    return () => {
      cancelled = true;
    };
  }, [clearAuth]);

  useEffect(() => {
    if (authState === "authenticated") {
      void refresh();
    }
  }, [authState, refresh]);

  useEffect(() => {
    if (authState !== "authenticated") {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshSummary();
    }, 60000);
    return () => window.clearInterval(interval);
  }, [authState, refreshSummary]);

  if (authState === "checking") {
    return <ShellStatus message={t("Checking admin session...")} />;
  }

  if (authState === "anonymous") {
    return (
      <LoginScreen
        languageSetting={languageSetting}
        onLanguageChange={handleLanguageChange}
        t={t}
        theme={theme}
        onThemeToggle={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
        onLogin={async (email, password) => {
          await login(email, password);
          setAdminEmail(email);
          setAuthState("authenticated");
        }}
      />
    );
  }

  return (
    <AppShell
      activeSection={activeSection}
      adminEmail={adminEmail}
      currentTimeLabel={formatUtcClock(utcNow)}
      languageSetting={languageSetting}
      loading={loading}
      onLanguageChange={handleLanguageChange}
      onLogout={handleLogout}
      onNavigate={handleNavigate}
      onOpenPrices={handleOpenPrices}
      onRefresh={refresh}
      onThemeToggle={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
      t={t}
      theme={theme}
    >
      <FilterToolbar
        deviceOptions={data?.deviceOptions.rows ?? data?.devices.rows ?? []}
        filters={filters}
        modelOptions={modelOptions}
        onChange={(key, value) => updateFilter(setFilters, setEventOffset, setTaskOffset, key, value)}
        projectOptions={data?.projectOptions.rows ?? data?.projects.rows ?? []}
        t={t}
        timeZoneOptions={reportingTimeZoneOptions}
        toolOptions={data?.tools.rows ?? []}
      />

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="overview-grid" id="dashboard-overview" ref={overviewRef} tabIndex={-1}>
        <MetricsOverview initialLoading={loading && !data} summary={data?.summary} t={t} />
        <section id="dashboard-trend" ref={trendRef} tabIndex={-1}>
          <TrendPanel
            initialLoading={loading && !data}
            language={language}
            meta={`${filters.from} to ${filters.to} (${filters.timeZone})`}
            points={data?.trends.points ?? []}
            projectRatios={data?.projectRatios ?? { daily: [], total: [] }}
            t={t}
            theme={theme}
          />
        </section>
      </section>

      <section className="panel" id="dashboard-explorer" ref={explorerRef} tabIndex={-1}>
        <DataExplorer
          activeTab={activeTab}
          onTabChange={setActiveTab}
          t={t}
          renderPanel={() => (
            <>
        {activeTab === "events" ? (
          <EventsTable
            rows={data?.events.rows ?? []}
            total={data?.events.total ?? 0}
            limit={eventPageLimit}
            offset={eventOffset}
            sort={eventSort}
            onSortChange={(nextSort) => {
              setEventOffset(0);
              setEventSort(nextSort);
            }}
            onPrevious={() => setEventOffset((current) => Math.max(0, current - eventPageLimit))}
            onNext={() => setEventOffset((current) => current + eventPageLimit)}
            t={t}
          />
        ) : null}
        {activeTab === "tasks" ? (
          <TasksTable
            rows={data?.tasks.rows ?? []}
            total={data?.tasks.total ?? 0}
            limit={taskPageLimit}
            offset={taskOffset}
            sort={taskSort}
            onSortChange={(nextSort) => {
              setTaskOffset(0);
              setTaskSort(nextSort);
            }}
            onPrevious={() => setTaskOffset((current) => Math.max(0, current - taskPageLimit))}
            onNext={() => setTaskOffset((current) => current + taskPageLimit)}
            t={t}
          />
        ) : null}
        {activeTab === "devices" ? <DevicesTable rows={data?.devices.rows ?? []} t={t} /> : null}
        {activeTab === "projects" ? (
          <ProjectsTable rows={data?.projects.rows ?? []} sort={projectSort} onSortChange={setProjectSort} t={t} />
        ) : null}
        {activeTab === "prices" ? (
          <PricesPanel
            rows={data?.modelPrices.rows ?? []}
            draft={priceDraft}
            loading={loading}
            onDraftChange={setPriceDraft}
            onSave={handleSavePrice}
            onDelete={handleDeletePrice}
            onEdit={(price) => setPriceDraft(draftFromPrice(price))}
            priceError={priceError}
            t={t}
          />
        ) : null}
            </>
          )}
        />
      </section>
    </AppShell>
  );
}

function LoginScreen({
  languageSetting,
  onLanguageChange,
  onLogin,
  theme,
  onThemeToggle,
  t
}: {
  languageSetting: LanguageSetting;
  onLanguageChange: (value: LanguageSetting) => void;
  onLogin: (email: string, password: string) => Promise<void>;
  theme: "light" | "dark";
  onThemeToggle: () => void;
  t: (key: string) => string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onLogin(email, password);
    } catch {
      setError(t("Invalid email or password"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-layout">
      <div className="login-bg-glow login-bg-glow-1"></div>
      <div className="login-bg-glow login-bg-glow-2"></div>
      <form className="login-panel" onSubmit={handleSubmit}>
        <div className="login-header-row">
          <div>
            <p className="eyebrow">{t("Codex Usage")}</p>
            <h1>{t("Admin login")}</h1>
          </div>
          <button
            type="button"
            className="theme-toggle-button"
            onClick={onThemeToggle}
            aria-label="Toggle Theme"
          >
            {theme === "light" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5"></circle>
                <line x1="12" y1="1" x2="12" y2="3"></line>
                <line x1="12" y1="21" x2="12" y2="23"></line>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                <line x1="1" y1="12" x2="3" y2="12"></line>
                <line x1="21" y1="12" x2="23" y2="12"></line>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
              </svg>
            )}
          </button>
        </div>
        <LanguageSelect value={languageSetting} onChange={onLanguageChange} t={t} />
        <label>
          {t("Email")}
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label>
          {t("Password")}
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error ? <div className="error-banner compact">{error}</div> : null}
        <button className="primary-button full-width" type="submit" disabled={submitting}>
          {submitting ? t("Signing in...") : t("Sign in")}
        </button>
      </form>
    </main>
  );
}

function LanguageSelect({
  value,
  onChange,
  t
}: {
  value: LanguageSetting;
  onChange: (value: LanguageSetting) => void;
  t: (key: string) => string;
}) {
  return (
    <label className="language-control">
      {t("Language")}
      <select value={value} onChange={(event) => onChange(event.target.value as LanguageSetting)}>
        {languageOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {t(option.labelKey)}
          </option>
        ))}
      </select>
    </label>
  );
}

function getMetricIcon(label: string) {
  const lowercase = label.toLowerCase();
  if (lowercase.includes("total") || lowercase.includes("总") || lowercase.includes("합계")) {
    return (
      <div className="metric-icon total">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path>
        </svg>
      </div>
    );
  }
  if (lowercase.includes("cache") || lowercase.includes("缓存") || lowercase.includes("캐시")) {
    return (
      <div className="metric-icon cache">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 12H2M22 6H2M22 18H2"></path>
          <circle cx="12" cy="6" r="1.5"></circle>
          <circle cx="12" cy="12" r="1.5"></circle>
          <circle cx="12" cy="18" r="1.5"></circle>
        </svg>
      </div>
    );
  }
  if (lowercase.includes("input") || lowercase.includes("输入") || lowercase.includes("입력")) {
    return (
      <div className="metric-icon input">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <polyline points="19 12 12 19 5 12"></polyline>
        </svg>
      </div>
    );
  }
  if (lowercase.includes("output") || lowercase.includes("输出") || lowercase.includes("출력")) {
    return (
      <div className="metric-icon output">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="19" x2="12" y2="5"></line>
          <polyline points="5 12 12 5 19 12"></polyline>
        </svg>
      </div>
    );
  }
  if (lowercase.includes("cost") || lowercase.includes("成本") || lowercase.includes("비용")) {
    return (
      <div className="metric-icon cost">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="1" x2="12" y2="23"></line>
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
        </svg>
      </div>
    );
  }
  return null;
}

function MetricCard({
  label,
  value,
  loading,
  detail,
  formatter = formatMetricNumber
}: {
  label: string;
  value: number | undefined;
  loading: boolean;
  detail?: string;
  formatter?: (value: number) => string;
}) {
  const [animating, setAnimating] = useState(false);
  const previousValue = useRef<number | undefined>(undefined);
  const formattedValue = loading ? "..." : formatter(value ?? 0);

  useEffect(() => {
    if (value === undefined) {
      return;
    }
    if (previousValue.current !== undefined && previousValue.current !== value) {
      setAnimating(true);
      const timeout = window.setTimeout(() => setAnimating(false), 620);
      previousValue.current = value;
      return () => window.clearTimeout(timeout);
    }
    previousValue.current = value;
  }, [value]);

  return (
    <article className="metric-card">
      <div className="metric-card-header">
        <span>{label}</span>
        {getMetricIcon(label)}
      </div>
      <strong className={animating ? "metric-value updating" : "metric-value"}>
        <span className="sr-only">{formattedValue}</span>
        <RollingMetricValue value={formattedValue} />
      </strong>
      {detail ? <small>{detail}</small> : null}
    </article>
  );
}

function RollingMetricValue({ value }: { value: string }) {
  return (
    <span className="rolling-number" aria-hidden="true">
      {[...value].map((character, index) =>
        /\d/.test(character) ? (
          <span
            className="metric-digit-window"
            key={`digit-${index}`}
            style={{ "--metric-digit": Number(character) } as CSSProperties}
          >
            <span className="metric-digit-stack">
              {"0123456789".split("").map((digit) => (
                <span className="metric-digit" key={digit}>
                  {digit}
                </span>
              ))}
            </span>
          </span>
        ) : (
          <span className="metric-symbol" key={`symbol-${index}`}>
            {character}
          </span>
        )
      )}
    </span>
  );
}

export function createTrendChartOption(
  points: TrendPoint[],
  t: (key: string) => string,
  language: Language,
  theme: "light" | "dark" = "light",
  trendMode: "daily" | "cumulative" = "daily",
  trendFilter: "all" | "cost" | "tokens" = "all"
) {
  let processedPoints = [...points];
  if (trendMode === "cumulative") {
    let cumulativeTotal = 0;
    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    let cumulativeCache = 0;
    let cumulativeCost = 0;

    processedPoints = points.map((point) => {
      cumulativeTotal += point.totalTokens;
      cumulativeInput += point.inputTokens;
      cumulativeOutput += point.outputTokens;
      cumulativeCache += (point.cacheReadTokens + point.cacheWriteTokens);
      cumulativeCost += point.costUsd;

      return {
        ...point,
        totalTokens: cumulativeTotal,
        inputTokens: cumulativeInput,
        outputTokens: cumulativeOutput,
        cacheReadTokens: cumulativeCache,
        cacheWriteTokens: 0,
        costUsd: cumulativeCost
      };
    });
  }

  const labels = processedPoints.map((point) => formatUtcDateLabel(point.day));
  const totals = processedPoints.map((point) => point.totalTokens);
  const inputs = processedPoints.map((point) => point.inputTokens);
  const outputs = processedPoints.map((point) => point.outputTokens);
  const cacheTokens = processedPoints.map((point) => point.cacheReadTokens + point.cacheWriteTokens);
  const costs = processedPoints.map((point) => point.costUsd);

  const isDark = theme === "dark";
  const textColor = isDark ? "#94a3b8" : "#475569";
  const splitLineColor = isDark ? "rgba(148, 163, 184, 0.06)" : "#e2e8f0";
  const axisLineColor = isDark ? "rgba(148, 163, 184, 0.15)" : "#cbd5e1";

  const colors = isDark
    ? ["#3b82f6", "#14b8a6", "#f97316", "#06b6d4", "#a855f7"]
    : ["#2563eb", "#0f766e", "#b45309", "#0891b2", "#7c3aed"];

  const areaColors = isDark
    ? [
        { start: "rgba(59, 130, 246, 0.22)", end: "rgba(59, 130, 246, 0.01)" },
        { start: "rgba(20, 184, 166, 0.18)", end: "rgba(20, 184, 166, 0.01)" },
        { start: "rgba(249, 115, 22, 0.18)", end: "rgba(249, 115, 22, 0.01)" },
        { start: "rgba(6, 182, 212, 0.18)", end: "rgba(6, 182, 212, 0.01)" },
        { start: "rgba(168, 85, 247, 0.22)", end: "rgba(168, 85, 247, 0.01)" }
      ]
    : [
        { start: "rgba(37, 99, 235, 0.18)", end: "rgba(37, 99, 235, 0.00)" },
        { start: "rgba(15, 118, 110, 0.12)", end: "rgba(15, 118, 110, 0.00)" },
        { start: "rgba(180, 83, 9, 0.12)", end: "rgba(180, 83, 9, 0.00)" },
        { start: "rgba(8, 145, 178, 0.12)", end: "rgba(8, 145, 178, 0.00)" },
        { start: "rgba(124, 58, 237, 0.18)", end: "rgba(124, 58, 237, 0.00)" }
      ];

  const allSeries = [
    {
      name: t("Total tokens"),
      type: "line",
      smooth: true,
      data: totals,
      symbolSize: 6,
      itemStyle: { color: colors[0] },
      lineStyle: { width: 3 },
      areaStyle: {
        color: {
          type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: areaColors[0].start }, { offset: 1, color: areaColors[0].end }]
        }
      }
    },
    {
      name: t("Input"),
      type: "line",
      smooth: true,
      data: inputs,
      symbolSize: 5,
      itemStyle: { color: colors[1] },
      lineStyle: { width: 2 },
      areaStyle: {
        color: {
          type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: areaColors[1].start }, { offset: 1, color: areaColors[1].end }]
        }
      }
    },
    {
      name: t("Output"),
      type: "line",
      smooth: true,
      data: outputs,
      symbolSize: 5,
      itemStyle: { color: colors[2] },
      lineStyle: { width: 2 },
      areaStyle: {
        color: {
          type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: areaColors[2].start }, { offset: 1, color: areaColors[2].end }]
        }
      }
    },
    {
      name: t("Cache"),
      type: "line",
      smooth: true,
      data: cacheTokens,
      symbolSize: 5,
      itemStyle: { color: colors[3] },
      lineStyle: { width: 2 },
      areaStyle: {
        color: {
          type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: areaColors[3].start }, { offset: 1, color: areaColors[3].end }]
        }
      }
    },
    {
      name: t("Cost"),
      type: "line",
      smooth: true,
      data: costs,
      symbolSize: 5,
      itemStyle: { color: colors[4] },
      lineStyle: { width: 2.5 },
      areaStyle: {
        color: {
          type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: areaColors[4].start }, { offset: 1, color: areaColors[4].end }]
        }
      }
    }
  ];

  let series = allSeries;
  let activeColors = colors;
  if (trendFilter === "cost") {
    series = [allSeries[4]];
    activeColors = [colors[4]];
  } else if (trendFilter === "tokens") {
    series = [allSeries[0], allSeries[1], allSeries[2], allSeries[3]];
    activeColors = [colors[0], colors[1], colors[2], colors[3]];
  }

  return {
    color: activeColors,
    grid: { top: 36, right: 18, bottom: 32, left: 58 },
    tooltip: {
      trigger: "axis",
      backgroundColor: isDark ? "rgba(17, 24, 39, 0.85)" : "rgba(255, 255, 255, 0.85)",
      borderColor: isDark ? "rgba(255, 255, 255, 0.12)" : "rgba(15, 23, 42, 0.08)",
      textStyle: { color: isDark ? "#f3f4f6" : "#1e293b" },
      extraCssText: "backdrop-filter: blur(10px); border-radius: 8px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);"
    },
    legend: {
      top: 0,
      right: 0,
      textStyle: { color: textColor }
    },
    xAxis: {
      type: "category",
      data: labels,
      boundaryGap: false,
      axisLabel: { color: textColor },
      axisLine: { lineStyle: { color: axisLineColor } }
    },
    yAxis: {
      type: "value",
      axisLabel: {
        color: textColor,
        formatter: (value: number) => compactNumber(value, language)
      },
      splitLine: { lineStyle: { color: splitLineColor } }
    },
    series
  };
}

function TrendChart({
  points,
  loading,
  language,
  t,
  theme,
  trendMode,
  trendFilter
}: {
  points: TrendPoint[];
  loading: boolean;
  language: Language;
  t: (key: string) => string;
  theme: "light" | "dark";
  trendMode: "daily" | "cumulative";
  trendFilter: "all" | "cost" | "tokens";
}) {
  const chartElement = useRef<HTMLDivElement | null>(null);
  const chartOption = useMemo(
    () => createTrendChartOption(points, t, language, theme, trendMode, trendFilter),
    [language, points, t, theme, trendMode, trendFilter]
  );

  useEffect(() => {
    if (!chartElement.current || loading) {
      return;
    }

    let chart: ECharts | null = null;
    const handleResize = () => chart?.resize();

    chart = init(chartElement.current);
    chart.setOption(chartOption);
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart?.dispose();
    };
  }, [chartOption, loading]);

  if (loading) {
    return <div className="chart-empty">{t("Loading trend data...")}</div>;
  }

  if (points.length === 0) {
    return <div className="chart-empty">{t("No trend data for this range.")}</div>;
  }

  return <div className="chart-surface" ref={chartElement} role="img" aria-label={t("Token usage trend chart")} />;
}

function EventsTable({
  rows,
  total,
  limit,
  offset,
  sort,
  onSortChange,
  onPrevious,
  onNext,
  t
}: {
  rows: UsageEvent[];
  total: number;
  limit: number;
  offset: number;
  sort: EventSort;
  onSortChange: (sort: EventSort) => void;
  onPrevious: () => void;
  onNext: () => void;
  t: (key: string) => string;
}) {
  const pageEnd = Math.min(offset + limit, total);

  return (
    <>
      <PanelHeader title={t("Usage events")} meta={`${formatNumber(total)} ${t("total")}`} />
      <div className="table-controls">
        <label>
          {t("Sort")}
          <select value={sort} onChange={(event) => onSortChange(event.target.value as EventSort)}>
            <option value="occurredAt-desc">{t("Newest first")}</option>
            <option value="occurredAt-asc">{t("Oldest first")}</option>
            <option value="totalTokens-desc">{t("Total tokens high to low")}</option>
            <option value="totalTokens-asc">{t("Total tokens low to high")}</option>
            <option value="costUsd-desc">{t("Cost high to low")}</option>
            <option value="costUsd-asc">{t("Cost low to high")}</option>
            <option value="inputTokens-desc">{t("Input tokens high to low")}</option>
            <option value="inputTokens-asc">{t("Input tokens low to high")}</option>
            <option value="outputTokens-desc">{t("Output tokens high to low")}</option>
            <option value="outputTokens-asc">{t("Output tokens low to high")}</option>
            <option value="cacheTokens-desc">{t("Cache tokens high to low")}</option>
            <option value="cacheTokens-asc">{t("Cache tokens low to high")}</option>
          </select>
        </label>
        <div className="pagination-controls" aria-label="Event pagination">
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
              <th>{t("Time")}</th>
              <th>{t("Tool")}</th>
              <th>{t("Model")}</th>
              <th className="numeric">{t("Input")}</th>
              <th className="numeric">{t("Output")}</th>
              <th className="numeric">{t("Cache")}</th>
              <th className="numeric">{t("Total tokens")}</th>
              <th className="numeric">{t("Cost")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{formatDateTime(row.occurredAt)}</td>
                <td>{row.tool}</td>
                <td>{row.model}</td>
                <td className="numeric">{formatNumber(row.inputTokens)}</td>
                <td className="numeric">{formatNumber(row.outputTokens)}</td>
                <td className="numeric">{formatNumber(row.cacheReadTokens + row.cacheWriteTokens)}</td>
                <td className="numeric strong">{formatNumber(row.totalTokens)}</td>
                <td className="numeric strong">{formatCurrency(row.costUsd)}</td>
              </tr>
            ))}
            {rows.length === 0 ? <EmptyRow columns={8} label={t("No usage events in this range")} /> : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function DevicesTable({ rows, t }: { rows: Device[]; t: (key: string) => string }) {
  return (
    <>
      <PanelHeader title={t("Devices")} meta={`${formatNumber(rows.length)} ${t("registered")}`} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("Name")}</th>
              <th>{t("OS")}</th>
              <th>{t("Hostname hash")}</th>
              <th className="numeric">{t("Events")}</th>
              <th className="numeric">{t("Total tokens")}</th>
              <th className="numeric">{t("Cost")}</th>
              <th>{t("Last seen")}</th>
              <th>{t("Status")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td>{row.os}</td>
                <td className="mono">{row.hostnameHash || "none"}</td>
                <td className="numeric">{formatNumber(row.eventCount)}</td>
                <td className="numeric strong">{formatNumber(row.totalTokens)}</td>
                <td className="numeric strong">{formatCurrency(row.costUsd)}</td>
                <td>{row.lastSeenAt ? formatDateTime(row.lastSeenAt) : t("Never")}</td>
                <td>
                  <span className={row.disabledAt ? "status disabled" : "status active"}>
                    {row.disabledAt ? t("Disabled") : t("Active")}
                  </span>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? <EmptyRow columns={8} label={t("No registered devices")} /> : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ProjectsTable({
  rows,
  sort,
  onSortChange,
  t
}: {
  rows: Project[];
  sort: ProjectSort;
  onSortChange: (sort: ProjectSort) => void;
  t: (key: string) => string;
}) {
  return (
    <>
      <PanelHeader title={t("Projects")} meta={`${formatNumber(rows.length)} ${t("tracked")}`} />
      <div className="table-controls">
        <label>
          {t("Sort")}
          <select value={sort} onChange={(event) => onSortChange(event.target.value as ProjectSort)}>
            <option value="updatedAt-desc">{t("Updated newest first")}</option>
            <option value="updatedAt-asc">{t("Updated oldest first")}</option>
            <option value="eventCount-desc">{t("Events high to low")}</option>
            <option value="eventCount-asc">{t("Events low to high")}</option>
            <option value="totalTokens-desc">{t("Total tokens high to low")}</option>
            <option value="totalTokens-asc">{t("Total tokens low to high")}</option>
            <option value="costUsd-desc">{t("Cost high to low")}</option>
            <option value="costUsd-asc">{t("Cost low to high")}</option>
          </select>
        </label>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("Name")}</th>
              <th>{t("Repo")}</th>
              <th>{t("Remote")}</th>
              <th className="numeric">{t("Events")}</th>
              <th className="numeric">{t("Total tokens")}</th>
              <th className="numeric">{t("Cost")}</th>
              <th>{t("Updated")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.displayName}</td>
                <td className="mono">{row.repoHash ?? "none"}</td>
                <td className="mono">{row.remoteHash ?? "none"}</td>
                <td className="numeric">{formatNumber(row.eventCount)}</td>
                <td className="numeric strong">{formatNumber(row.totalTokens)}</td>
                <td className="numeric strong">{formatCurrency(row.costUsd)}</td>
                <td>{formatDateTime(row.updatedAt)}</td>
              </tr>
            ))}
            {rows.length === 0 ? <EmptyRow columns={7} label={t("No tracked projects")} /> : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PricesPanel({
  rows,
  draft,
  loading,
  onDraftChange,
  onSave,
  onDelete,
  onEdit,
  priceError,
  t
}: {
  rows: ModelPrice[];
  draft: PriceDraft;
  loading: boolean;
  onDraftChange: Dispatch<SetStateAction<PriceDraft>>;
  onSave: () => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onEdit: (price: ModelPrice) => void;
  priceError: string | null;
  t: (key: string) => string;
}) {
  return (
    <>
      <PanelHeader title={t("Model prices")} meta={`${formatNumber(rows.length)} ${t("configured")}`} />
      <form
        aria-label={t("Model prices")}
        className="price-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave();
        }}
      >
        {priceError ? <div className="error-banner compact" role="alert">{priceError}</div> : null}
        <label>
          {t("Price model")}
          <input
            value={draft.model}
            onChange={(event) => onDraftChange((current) => ({ ...current, model: event.target.value }))}
          />
        </label>
        <label>
          {t("Input USD / 1M")}
          <input
            type="number"
            min="0"
            step="0.0001"
            value={draft.inputCostPerMillionUsd}
            onChange={(event) =>
              onDraftChange((current) => ({ ...current, inputCostPerMillionUsd: event.target.value }))
            }
          />
        </label>
        <label>
          {t("Output USD / 1M")}
          <input
            type="number"
            min="0"
            step="0.0001"
            value={draft.outputCostPerMillionUsd}
            onChange={(event) =>
              onDraftChange((current) => ({ ...current, outputCostPerMillionUsd: event.target.value }))
            }
          />
        </label>
        <label>
          {t("Cache read USD / 1M")}
          <input
            type="number"
            min="0"
            step="0.0001"
            value={draft.cacheReadCostPerMillionUsd}
            onChange={(event) =>
              onDraftChange((current) => ({ ...current, cacheReadCostPerMillionUsd: event.target.value }))
            }
          />
        </label>
        <label>
          {t("Cache write USD / 1M")}
          <input
            type="number"
            min="0"
            step="0.0001"
            value={draft.cacheWriteCostPerMillionUsd}
            onChange={(event) =>
              onDraftChange((current) => ({ ...current, cacheWriteCostPerMillionUsd: event.target.value }))
            }
          />
        </label>
        <button type="submit" className="primary-button" disabled={loading || !draft.model.trim()}>
          {t("Save price")}
        </button>
      </form>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("Model")}</th>
              <th className="numeric">{t("Input")}</th>
              <th className="numeric">{t("Output")}</th>
              <th className="numeric">{t("Cache read")}</th>
              <th className="numeric">{t("Cache write")}</th>
              <th className="numeric">{t("Actions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.model}</td>
                <td className="numeric">{formatRate(row.inputCostPerMillionUsd)}</td>
                <td className="numeric">{formatRate(row.outputCostPerMillionUsd)}</td>
                <td className="numeric">{formatRate(row.cacheReadCostPerMillionUsd)}</td>
                <td className="numeric">{formatRate(row.cacheWriteCostPerMillionUsd)}</td>
                <td className="numeric row-actions">
                  <button type="button" className="secondary-button" onClick={() => onEdit(row)}>
                    {t("Edit")}
                  </button>
                  <button
                    type="button"
                    className="secondary-button danger-button"
                    aria-label={`${t("Delete")} ${row.model} ${t("price")}`}
                    onClick={() => void onDelete(row.id)}
                  >
                    {t("Delete")}
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? <EmptyRow columns={6} label={t("No model prices configured")} /> : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PanelHeader({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="panel-header">
      <h2>{title}</h2>
      {meta ? <span>{meta}</span> : null}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={active ? "tab-button active" : "tab-button"}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function EmptyRow({ columns, label }: { columns: number; label: string }) {
  return (
    <tr>
      <td className="empty-cell" colSpan={columns}>
        {label}
      </td>
    </tr>
  );
}

function ShellStatus({ message }: { message: string }) {
  return (
    <main className="login-layout">
      <div className="login-panel status-panel">{message}</div>
    </main>
  );
}

function translate(language: Language, key: string): string {
  return translations[language][key] ?? key;
}

function readStoredLanguageSetting(): LanguageSetting {
  if (typeof window === "undefined") {
    return "auto";
  }
  try {
    return normalizeLanguageSetting(window.localStorage.getItem(languageStorageKey));
  } catch {
    return "auto";
  }
}

function writeStoredLanguageSetting(value: LanguageSetting): void {
  try {
    window.localStorage.setItem(languageStorageKey, value);
  } catch {
    // Non-critical preference persistence can fail in restricted browser modes.
  }
}

function normalizeLanguageSetting(value: string | null): LanguageSetting {
  return value === "zh" || value === "ja" || value === "en" || value === "ko" || value === "auto" ? value : "auto";
}

function getBrowserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") {
    return [];
  }
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

export function resolveLanguageSetting(
  setting: LanguageSetting,
  browserLanguages: readonly string[] = getBrowserLanguages()
): Language {
  if (setting !== "auto") {
    return setting;
  }
  for (const browserLanguage of browserLanguages) {
    const normalized = browserLanguage.toLowerCase();
    if (normalized === "zh" || normalized.startsWith("zh-")) {
      return "zh";
    }
    if (normalized === "ja" || normalized.startsWith("ja-")) {
      return "ja";
    }
    if (normalized === "ko" || normalized.startsWith("ko-")) {
      return "ko";
    }
    if (normalized === "en" || normalized.startsWith("en-")) {
      return "en";
    }
  }
  return "en";
}

function defaultFilters(): UsageFilters {
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - 13);
  return {
    from: toReportingDateInputValue(start, defaultReportingTimeZone),
    to: toReportingDateInputValue(today, defaultReportingTimeZone),
    timeZone: defaultReportingTimeZone
  };
}

export function toReportingDateInputValue(date: Date, timeZone = defaultReportingTimeZone): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatUtcDateLabel(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

function formatMetricNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatMetricCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatRate(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function compactNumber(value: number, language: Language): string {
  return Intl.NumberFormat(languageLocales[language], { notation: "compact", maximumFractionDigits: 1 }).format(value);
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

function formatUtcClock(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second} UTC`;
}

function isUnauthorized(value: unknown): boolean {
  return value instanceof ApiError && value.status === 401;
}

function updateFilter(
  setFilters: Dispatch<SetStateAction<UsageFilters>>,
  setEventOffset: Dispatch<SetStateAction<number>>,
  setTaskOffset: Dispatch<SetStateAction<number>>,
  key: keyof UsageFilters,
  value: string | undefined
): void {
  setEventOffset(0);
  setTaskOffset(0);
  setFilters((current) => ({ ...current, [key]: value }));
}

function deriveModelOptions(data: DashboardData | null): string[] {
  const models = new Set<string>();
  for (const row of data?.models.rows ?? []) {
    if (row.model) {
      models.add(row.model);
    }
  }
  return [...models].sort((left, right) => left.localeCompare(right));
}

function eventSortToRequest(sort: EventSort): { sortBy: EventSortBy; sortDir: SortDir } {
  const [sortBy, sortDir] = sort.split("-") as [EventSortBy, SortDir];
  return { sortBy, sortDir };
}

function projectSortToRequest(sort: ProjectSort): { sortBy: ProjectSortBy; sortDir: SortDir } {
  const [sortBy, sortDir] = sort.split("-") as [ProjectSortBy, SortDir];
  return { sortBy, sortDir };
}

function taskSortToRequest(sort: TaskSort): { sortBy: TaskSortBy; sortDir: SortDir } {
  const [sortBy, sortDir] = sort.split("-") as [TaskSortBy, SortDir];
  return { sortBy, sortDir };
}

function draftFromPrice(price: ModelPrice): PriceDraft {
  return {
    model: price.model,
    inputCostPerMillionUsd: String(price.inputCostPerMillionUsd),
    outputCostPerMillionUsd: String(price.outputCostPerMillionUsd),
    cacheReadCostPerMillionUsd: String(price.cacheReadCostPerMillionUsd),
    cacheWriteCostPerMillionUsd: String(price.cacheWriteCostPerMillionUsd)
  };
}

function priceDraftToInput(draft: PriceDraft): ModelPriceInput {
  return {
    model: draft.model.trim(),
    inputCostPerMillionUsd: Number(draft.inputCostPerMillionUsd),
    outputCostPerMillionUsd: Number(draft.outputCostPerMillionUsd),
    cacheReadCostPerMillionUsd: Number(draft.cacheReadCostPerMillionUsd),
    cacheWriteCostPerMillionUsd: Number(draft.cacheWriteCostPerMillionUsd)
  };
}
