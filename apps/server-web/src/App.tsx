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
  type TrendPoint,
  type UsageEvent,
  type UsageFilters
} from "./api.js";

type AuthState = "checking" | "authenticated" | "anonymous";
type Tab = "events" | "devices" | "projects" | "prices";
type Language = "zh" | "ja" | "en" | "ko";
type LanguageSetting = "auto" | Language;
type EventSort =
  | "occurredAt-desc"
  | "occurredAt-asc"
  | "totalTokens-desc"
  | "totalTokens-asc"
  | "costUsd-desc"
  | "costUsd-asc"
  | "inputTokens-desc"
  | "inputTokens-asc"
  | "outputTokens-desc"
  | "outputTokens-asc"
  | "cacheTokens-desc"
  | "cacheTokens-asc";
type ProjectSort =
  | "updatedAt-desc"
  | "updatedAt-asc"
  | "eventCount-desc"
  | "eventCount-asc"
  | "totalTokens-desc"
  | "totalTokens-asc"
  | "costUsd-desc"
  | "costUsd-asc";

const eventPageLimit = 25;
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
const translations: Record<Language, Record<string, string>> = {
  en: {},
  zh: {
    "Checking admin session...": "正在检查管理员会话...",
    "Current UTC time": "当前 UTC 时间",
    "Codex Usage Dashboard": "Codex Token 用量看板",
    Logout: "退出",
    "Refreshing...": "刷新中...",
    Refresh: "刷新",
    Language: "语言",
    Auto: "自动",
    Chinese: "中文",
    Japanese: "日语",
    English: "英语",
    Korean: "韩语",
    "Dashboard filters": "看板筛选",
    From: "开始日期",
    To: "结束日期",
    Tool: "工具",
    "All tools": "全部工具",
    Device: "设备",
    "All devices": "全部设备",
    Project: "项目",
    "All projects": "全部项目",
    "Time zone": "时区",
    Model: "模型",
    "All models": "全部模型",
    "Total tokens": "总 Token",
    Input: "输入",
    Output: "输出",
    "Cache read": "缓存读取",
    Cost: "成本",
    "Usage trend": "用量趋势",
    Details: "明细",
    Events: "事件",
    Devices: "设备",
    Projects: "项目",
    Prices: "价格",
    "Usage events": "用量事件",
    total: "总计",
    Sort: "排序",
    "Newest first": "最新优先",
    "Oldest first": "最旧优先",
    "Total tokens high to low": "总 Token 从高到低",
    "Total tokens low to high": "总 Token 从低到高",
    "Cost high to low": "成本从高到低",
    "Cost low to high": "成本从低到高",
    "Input tokens high to low": "输入 Token 从高到低",
    "Input tokens low to high": "输入 Token 从低到高",
    "Output tokens high to low": "输出 Token 从高到低",
    "Output tokens low to high": "输出 Token 从低到高",
    "Cache tokens high to low": "缓存 Token 从高到低",
    "Cache tokens low to high": "缓存 Token 从低到高",
    "Events high to low": "事件数从高到低",
    "Events low to high": "事件数从低到高",
    "Updated newest first": "更新时间从新到旧",
    "Updated oldest first": "更新时间从旧到新",
    Previous: "上一页",
    Next: "下一页",
    of: "共",
    Time: "时间",
    Cache: "缓存",
    "No usage events in this range": "此范围内没有用量事件",
    Name: "名称",
    OS: "系统",
    "Hostname hash": "主机名哈希",
    "Last seen": "上次出现",
    Status: "状态",
    Never: "从未",
    Disabled: "已禁用",
    Active: "活跃",
    registered: "已注册",
    Repo: "仓库",
    Remote: "远端",
    Updated: "更新时间",
    tracked: "已跟踪",
    "No registered devices": "没有已注册设备",
    "No tracked projects": "没有已跟踪项目",
    "Model prices": "模型价格",
    configured: "已配置",
    "Price model": "计价模型",
    "Input USD / 1M": "输入 USD / 100万",
    "Output USD / 1M": "输出 USD / 100万",
    "Cache read USD / 1M": "缓存读取 USD / 100万",
    "Cache write USD / 1M": "缓存写入 USD / 100万",
    "Save price": "保存价格",
    price: "价格",
    "Cache write": "缓存写入",
    Actions: "操作",
    Edit: "编辑",
    Delete: "删除",
    "No model prices configured": "尚未配置模型价格",
    "Codex Usage": "Codex Token 用量",
    "Admin login": "管理员登录",
    Email: "邮箱",
    Password: "密码",
    "Invalid email or password": "邮箱或密码无效",
    "Signing in...": "登录中...",
    "Sign in": "登录",
    "Loading trend data...": "正在加载趋势数据...",
    "No trend data for this range.": "此范围内没有趋势数据。",
    "Token usage trend chart": "Token 用量趋势图",
    "Failed to load dashboard": "加载看板失败",
    "Failed to save model price": "保存模型价格失败",
    "Failed to delete model price": "删除模型价格失败"
  },
  ja: {
    "Checking admin session...": "管理者セッションを確認しています...",
    "Current UTC time": "現在の UTC 時刻",
    "Codex Usage Dashboard": "Codex Token 使用量ダッシュボード",
    Logout: "ログアウト",
    "Refreshing...": "更新中...",
    Refresh: "更新",
    Language: "言語",
    Auto: "自動",
    Chinese: "中国語",
    Japanese: "日本語",
    English: "英語",
    Korean: "韓国語",
    "Dashboard filters": "ダッシュボードフィルター",
    From: "開始日",
    To: "終了日",
    Tool: "ツール",
    "All tools": "すべてのツール",
    Device: "デバイス",
    "All devices": "すべてのデバイス",
    Project: "プロジェクト",
    "All projects": "すべてのプロジェクト",
    "Time zone": "タイムゾーン",
    Model: "モデル",
    "All models": "すべてのモデル",
    "Total tokens": "合計トークン",
    Input: "入力",
    Output: "出力",
    "Cache read": "キャッシュ読み取り",
    Cost: "コスト",
    "Usage trend": "使用量推移",
    Details: "詳細",
    Events: "イベント",
    Devices: "デバイス",
    Projects: "プロジェクト",
    Prices: "価格",
    "Usage events": "使用量イベント",
    total: "合計",
    Sort: "並び替え",
    "Newest first": "新しい順",
    "Oldest first": "古い順",
    "Total tokens high to low": "合計トークンの多い順",
    "Total tokens low to high": "合計トークンの少ない順",
    "Cost high to low": "コストの高い順",
    "Cost low to high": "コストの低い順",
    "Input tokens high to low": "入力トークンの多い順",
    "Input tokens low to high": "入力トークンの少ない順",
    "Output tokens high to low": "出力トークンの多い順",
    "Output tokens low to high": "出力トークンの少ない順",
    "Cache tokens high to low": "キャッシュトークンの多い順",
    "Cache tokens low to high": "キャッシュトークンの少ない順",
    "Events high to low": "イベント数の多い順",
    "Events low to high": "イベント数の少ない順",
    "Updated newest first": "更新日時の新しい順",
    "Updated oldest first": "更新日時の古い順",
    Previous: "前へ",
    Next: "次へ",
    of: "件中",
    Time: "時刻",
    Cache: "キャッシュ",
    "No usage events in this range": "この範囲に使用量イベントはありません",
    Name: "名前",
    OS: "OS",
    "Hostname hash": "ホスト名ハッシュ",
    "Last seen": "最終確認",
    Status: "状態",
    Never: "未確認",
    Disabled: "無効",
    Active: "有効",
    registered: "登録済み",
    Repo: "リポジトリ",
    Remote: "リモート",
    Updated: "更新日時",
    tracked: "追跡中",
    "No registered devices": "登録済みデバイスはありません",
    "No tracked projects": "追跡中のプロジェクトはありません",
    "Model prices": "モデル価格",
    configured: "設定済み",
    "Price model": "価格モデル",
    "Input USD / 1M": "入力 USD / 100万",
    "Output USD / 1M": "出力 USD / 100万",
    "Cache read USD / 1M": "キャッシュ読み取り USD / 100万",
    "Cache write USD / 1M": "キャッシュ書き込み USD / 100万",
    "Save price": "価格を保存",
    price: "価格",
    "Cache write": "キャッシュ書き込み",
    Actions: "操作",
    Edit: "編集",
    Delete: "削除",
    "No model prices configured": "モデル価格は未設定です",
    "Codex Usage": "Codex Token 使用量",
    "Admin login": "管理者ログイン",
    Email: "メール",
    Password: "パスワード",
    "Invalid email or password": "メールまたはパスワードが無効です",
    "Signing in...": "サインイン中...",
    "Sign in": "サインイン",
    "Loading trend data...": "推移データを読み込んでいます...",
    "No trend data for this range.": "この範囲に推移データはありません。",
    "Token usage trend chart": "Token 使用量推移グラフ",
    "Failed to load dashboard": "ダッシュボードの読み込みに失敗しました",
    "Failed to save model price": "モデル価格の保存に失敗しました",
    "Failed to delete model price": "モデル価格の削除に失敗しました"
  },
  ko: {
    "Checking admin session...": "관리자 세션을 확인하는 중...",
    "Current UTC time": "현재 UTC 시간",
    "Codex Usage Dashboard": "Codex Token 사용량 대시보드",
    Logout: "로그아웃",
    "Refreshing...": "새로고침 중...",
    Refresh: "새로고침",
    Language: "언어",
    Auto: "자동",
    Chinese: "중국어",
    Japanese: "일본어",
    English: "영어",
    Korean: "한국어",
    "Dashboard filters": "대시보드 필터",
    From: "시작일",
    To: "종료일",
    Tool: "도구",
    "All tools": "모든 도구",
    Device: "기기",
    "All devices": "모든 기기",
    Project: "프로젝트",
    "All projects": "모든 프로젝트",
    "Time zone": "시간대",
    Model: "모델",
    "All models": "모든 모델",
    "Total tokens": "총 토큰",
    Input: "입력",
    Output: "출력",
    "Cache read": "캐시 읽기",
    Cost: "비용",
    "Usage trend": "사용량 추세",
    Details: "세부 정보",
    Events: "이벤트",
    Devices: "기기",
    Projects: "프로젝트",
    Prices: "가격",
    "Usage events": "사용량 이벤트",
    total: "합계",
    Sort: "정렬",
    "Newest first": "최신순",
    "Oldest first": "오래된순",
    "Total tokens high to low": "총 토큰 높은순",
    "Total tokens low to high": "총 토큰 낮은순",
    "Cost high to low": "비용 높은순",
    "Cost low to high": "비용 낮은순",
    "Input tokens high to low": "입력 토큰 높은순",
    "Input tokens low to high": "입력 토큰 낮은순",
    "Output tokens high to low": "출력 토큰 높은순",
    "Output tokens low to high": "출력 토큰 낮은순",
    "Cache tokens high to low": "캐시 토큰 높은순",
    "Cache tokens low to high": "캐시 토큰 낮은순",
    "Events high to low": "이벤트 높은순",
    "Events low to high": "이벤트 낮은순",
    "Updated newest first": "업데이트 최신순",
    "Updated oldest first": "업데이트 오래된순",
    Previous: "이전",
    Next: "다음",
    of: "중",
    Time: "시간",
    Cache: "캐시",
    "No usage events in this range": "이 범위에는 사용량 이벤트가 없습니다",
    Name: "이름",
    OS: "OS",
    "Hostname hash": "호스트 이름 해시",
    "Last seen": "마지막 확인",
    Status: "상태",
    Never: "없음",
    Disabled: "비활성",
    Active: "활성",
    registered: "등록됨",
    Repo: "저장소",
    Remote: "원격",
    Updated: "업데이트됨",
    tracked: "추적됨",
    "No registered devices": "등록된 기기가 없습니다",
    "No tracked projects": "추적 중인 프로젝트가 없습니다",
    "Model prices": "모델 가격",
    configured: "설정됨",
    "Price model": "가격 모델",
    "Input USD / 1M": "입력 USD / 100만",
    "Output USD / 1M": "출력 USD / 100만",
    "Cache read USD / 1M": "캐시 읽기 USD / 100만",
    "Cache write USD / 1M": "캐시 쓰기 USD / 100만",
    "Save price": "가격 저장",
    price: "가격",
    "Cache write": "캐시 쓰기",
    Actions: "작업",
    Edit: "수정",
    Delete: "삭제",
    "No model prices configured": "설정된 모델 가격이 없습니다",
    "Codex Usage": "Codex Token 사용량",
    "Admin login": "관리자 로그인",
    Email: "이메일",
    Password: "비밀번호",
    "Invalid email or password": "이메일 또는 비밀번호가 올바르지 않습니다",
    "Signing in...": "로그인 중...",
    "Sign in": "로그인",
    "Loading trend data...": "추세 데이터를 불러오는 중...",
    "No trend data for this range.": "이 범위에는 추세 데이터가 없습니다.",
    "Token usage trend chart": "Token 사용량 추세 차트",
    "Failed to load dashboard": "대시보드를 불러오지 못했습니다",
    "Failed to save model price": "모델 가격을 저장하지 못했습니다",
    "Failed to delete model price": "모델 가격을 삭제하지 못했습니다"
  }
};
use([GridComponent, LegendComponent, LineChart, TooltipComponent, CanvasRenderer]);

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [languageSetting, setLanguageSetting] = useState<LanguageSetting>(() => readStoredLanguageSetting());
  const [adminEmail, setAdminEmail] = useState("");
  const [utcNow, setUtcNow] = useState(() => new Date());
  const [filters, setFilters] = useState<UsageFilters>(() => defaultFilters());
  const [data, setData] = useState<DashboardData | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("events");
  const [eventOffset, setEventOffset] = useState(0);
  const [eventSort, setEventSort] = useState<EventSort>("occurredAt-desc");
  const [projectSort, setProjectSort] = useState<ProjectSort>("updatedAt-desc");
  const [priceDraft, setPriceDraft] = useState<PriceDraft>(emptyPriceDraft);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        projectSortToRequest(projectSort)
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
  }, [clearAuth, deviceId, eventOffset, eventSort, from, model, projectId, projectSort, t, timeZone, to, tool]);

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
    setError(null);
    try {
      await saveModelPrice(priceDraftToInput(priceDraft));
      await refresh();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("Failed to save model price");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [priceDraft, refresh, t]);

  const handleDeletePrice = useCallback(
    async (id: string) => {
      setLoading(true);
      setError(null);
      try {
        await deleteModelPrice(id);
        setPriceDraft(emptyPriceDraft);
        await refresh();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : t("Failed to delete model price");
        setError(message);
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
        onLogin={async (email, password) => {
          await login(email, password);
          setAdminEmail(email);
          setAuthState("authenticated");
        }}
      />
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="utc-clock" aria-label={t("Current UTC time")}>
            {formatUtcClock(utcNow)}
          </p>
          <h1>{t("Codex Usage Dashboard")}</h1>
        </div>
        <div className="topbar-actions">
          <LanguageSelect value={languageSetting} onChange={handleLanguageChange} t={t} />
          <span className="admin-chip">{adminEmail}</span>
          <button type="button" className="secondary-button" onClick={handleLogout} disabled={loading}>
            {t("Logout")}
          </button>
          <button type="button" className="primary-button" onClick={refresh} disabled={loading}>
            {loading ? t("Refreshing...") : t("Refresh")}
          </button>
        </div>
      </header>

      <section className="filter-bar" aria-label={t("Dashboard filters")}>
        <label>
          {t("From")}
          <input
            type="date"
            value={filters.from}
            onChange={(event) => updateFilter(setFilters, setEventOffset, "from", event.target.value)}
          />
        </label>
        <label>
          {t("To")}
          <input
            type="date"
            value={filters.to}
            onChange={(event) => updateFilter(setFilters, setEventOffset, "to", event.target.value)}
          />
        </label>
        <label>
          {t("Tool")}
          <select
            value={filters.tool ?? ""}
            onChange={(event) => updateFilter(setFilters, setEventOffset, "tool", event.target.value || undefined)}
          >
            <option value="">{t("All tools")}</option>
            {data?.tools.rows.map((toolItem) => (
              <option key={toolItem.id} value={toolItem.slug}>
                {toolItem.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Device")}
          <select
            value={filters.deviceId ?? ""}
            onChange={(event) =>
              updateFilter(setFilters, setEventOffset, "deviceId", event.target.value || undefined)
            }
          >
            <option value="">{t("All devices")}</option>
            {(data?.deviceOptions.rows ?? data?.devices.rows ?? []).map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Project")}
          <select
            value={filters.projectId ?? ""}
            onChange={(event) =>
              updateFilter(setFilters, setEventOffset, "projectId", event.target.value || undefined)
            }
          >
            <option value="">{t("All projects")}</option>
            {(data?.projectOptions.rows ?? data?.projects.rows ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Time zone")}
          <select
            value={filters.timeZone}
            onChange={(event) => updateFilter(setFilters, setEventOffset, "timeZone", event.target.value)}
          >
            {reportingTimeZoneOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Model")}
          <select
            value={filters.model ?? ""}
            onChange={(event) => updateFilter(setFilters, setEventOffset, "model", event.target.value || undefined)}
          >
            <option value="">{t("All models")}</option>
            {modelOptions.map((modelName) => (
              <option key={modelName} value={modelName}>
                {modelName}
              </option>
            ))}
          </select>
        </label>
      </section>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="metrics-grid" aria-label="Token metrics">
        <MetricCard label={t("Total tokens")} value={data?.summary.totalTokens} loading={loading && !data} />
        <MetricCard label={t("Cache read")} value={data?.summary.cacheReadTokens} loading={loading && !data} />
        <MetricCard label={t("Input")} value={data?.summary.inputTokens} loading={loading && !data} />
        <MetricCard label={t("Output")} value={data?.summary.outputTokens} loading={loading && !data} />
        <MetricCard
          label={t("Cost")}
          value={data?.summary.costUsd}
          loading={loading && !data}
          formatter={formatMetricCurrency}
        />
      </section>

      <section className="panel chart-panel">
        <PanelHeader title={t("Usage trend")} meta={`${filters.from} to ${filters.to} (${filters.timeZone})`} />
        <TrendChart points={data?.trends.points ?? []} loading={loading && !data} language={language} t={t} />
      </section>

      <section className="panel">
        <div className="tab-row" role="tablist" aria-label={t("Details")}>
          <TabButton active={activeTab === "events"} onClick={() => setActiveTab("events")}>
            {t("Events")}
          </TabButton>
          <TabButton active={activeTab === "devices"} onClick={() => setActiveTab("devices")}>
            {t("Devices")}
          </TabButton>
          <TabButton active={activeTab === "projects"} onClick={() => setActiveTab("projects")}>
            {t("Projects")}
          </TabButton>
          <TabButton active={activeTab === "prices"} onClick={() => setActiveTab("prices")}>
            {t("Prices")}
          </TabButton>
        </div>
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
            t={t}
          />
        ) : null}
      </section>
    </main>
  );
}

function LoginScreen({
  languageSetting,
  onLanguageChange,
  onLogin,
  t
}: {
  languageSetting: LanguageSetting;
  onLanguageChange: (value: LanguageSetting) => void;
  onLogin: (email: string, password: string) => Promise<void>;
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
      <form className="login-panel" onSubmit={handleSubmit}>
        <div>
          <p className="eyebrow">{t("Codex Usage")}</p>
          <h1>{t("Admin login")}</h1>
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
      <span>{label}</span>
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

export function createTrendChartOption(points: TrendPoint[], t: (key: string) => string, language: Language) {
  const labels = points.map((point) => formatUtcDateLabel(point.day));
  const totals = points.map((point) => point.totalTokens);
  const inputs = points.map((point) => point.inputTokens);
  const outputs = points.map((point) => point.outputTokens);
  const cacheTokens = points.map((point) => point.cacheReadTokens + point.cacheWriteTokens);
  const costs = points.map((point) => point.costUsd);

  return {
    color: ["#2563eb", "#0f766e", "#b45309", "#0891b2", "#7c3aed"],
    grid: { top: 28, right: 18, bottom: 32, left: 58 },
    tooltip: { trigger: "axis" },
    legend: { top: 0, right: 0, textStyle: { color: "#475569" } },
    xAxis: { type: "category", data: labels, boundaryGap: false },
    yAxis: { type: "value", axisLabel: { formatter: (value: number) => compactNumber(value, language) } },
    series: [
      { name: t("Total tokens"), type: "line", smooth: true, data: totals, symbolSize: 6 },
      { name: t("Input"), type: "line", smooth: true, data: inputs, symbolSize: 5 },
      { name: t("Output"), type: "line", smooth: true, data: outputs, symbolSize: 5 },
      { name: t("Cache"), type: "line", smooth: true, data: cacheTokens, symbolSize: 5 },
      { name: t("Cost"), type: "line", smooth: true, data: costs, symbolSize: 5 }
    ]
  };
}

function TrendChart({
  points,
  loading,
  language,
  t
}: {
  points: TrendPoint[];
  loading: boolean;
  language: Language;
  t: (key: string) => string;
}) {
  const chartElement = useRef<HTMLDivElement | null>(null);
  const chartOption = useMemo(() => createTrendChartOption(points, t, language), [language, points, t]);

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

type PriceDraft = {
  model: string;
  inputCostPerMillionUsd: string;
  outputCostPerMillionUsd: string;
  cacheReadCostPerMillionUsd: string;
  cacheWriteCostPerMillionUsd: string;
};

function PricesPanel({
  rows,
  draft,
  loading,
  onDraftChange,
  onSave,
  onDelete,
  onEdit,
  t
}: {
  rows: ModelPrice[];
  draft: PriceDraft;
  loading: boolean;
  onDraftChange: Dispatch<SetStateAction<PriceDraft>>;
  onSave: () => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onEdit: (price: ModelPrice) => void;
  t: (key: string) => string;
}) {
  return (
    <>
      <PanelHeader title={t("Model prices")} meta={`${formatNumber(rows.length)} ${t("configured")}`} />
      <form
        className="price-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave();
        }}
      >
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
  return `$${value.toFixed(4)}`;
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
  key: keyof UsageFilters,
  value: string | undefined
): void {
  setEventOffset(0);
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
