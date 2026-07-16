export type Session = {
  email: string;
};

export type UsageSummary = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  eventCount: number;
};

export type TrendPoint = UsageSummary & {
  day: string;
  inputCostUsd?: number;
  outputCostUsd?: number;
  cacheCostUsd?: number;
  toolUsages?: Array<{
    toolSlug: string;
    toolName: string;
    totalTokens: number;
    costUsd: number;
  }>;
};

export type ProjectRatioItem = {
  projectKey: string;
  projectName: string;
  totalTokens: number;
};

export type ProjectRatioResponse = {
  daily: Array<{
    day: string;
    projects: ProjectRatioItem[];
  }>;
  total: ProjectRatioItem[];
};

export type UsageEvent = UsageSummary & {
  id: string;
  occurredAt: string;
  tool: string;
  deviceId: string | null;
  projectId: string | null;
  model: string;
};

export type TaskUsage = Omit<UsageSummary, "eventCount"> & {
  taskId: string;
  isFallback: boolean;
  startedAt: string;
  lastActivityAt: string;
  deviceId: string | null;
  deviceName: string | null;
  deviceCount: number;
  projectId: string | null;
  projectName: string | null;
  projectCount: number;
  eventCount: number;
};

export type Device = {
  id: string;
  name: string;
  os: string;
  hostnameHash: string;
  lastSeenAt: string | null;
  disabledAt: string | null;
  createdAt: string;
  totalTokens: number;
  costUsd: number;
  eventCount: number;
};

export type Project = {
  id: string;
  displayName: string;
  repoHash: string | null;
  remoteHash: string | null;
  pathHash: string | null;
  createdAt: string;
  updatedAt: string;
  totalTokens: number;
  costUsd: number;
  eventCount: number;
};

export type Tool = {
  id: string;
  slug: string;
  displayName: string;
  createdAt: string;
};

export type ModelOption = {
  model: string;
};

export type ModelPrice = {
  id: string;
  model: string;
  inputCostPerMillionUsd: number;
  outputCostPerMillionUsd: number;
  cacheReadCostPerMillionUsd: number;
  cacheWriteCostPerMillionUsd: number;
  createdAt: string;
  updatedAt: string;
};

export type ModelPriceInput = {
  model: string;
  inputCostPerMillionUsd: number;
  outputCostPerMillionUsd: number;
  cacheReadCostPerMillionUsd: number;
  cacheWriteCostPerMillionUsd: number;
};

export type UsageFilters = {
  from: string;
  to: string;
  timeZone: string;
  tool?: string;
  deviceId?: string;
  projectId?: string;
  model?: string;
};

export type EventSortBy =
  | "occurredAt"
  | "totalTokens"
  | "inputTokens"
  | "outputTokens"
  | "cacheTokens"
  | "costUsd";
export type ProjectSortBy = "eventCount" | "totalTokens" | "costUsd" | "updatedAt";
export type TaskSortBy = "lastActivityAt" | "eventCount" | "totalTokens" | "costUsd";
export type SortDir = "asc" | "desc";

export type DashboardData = {
  summary: UsageSummary;
  trends: { points: TrendPoint[] };
  projectRatios: ProjectRatioResponse;
  events: { rows: UsageEvent[]; total: number };
  tasks: { rows: TaskUsage[]; total: number };
  devices: { rows: Device[] };
  projects: { rows: Project[] };
  deviceOptions: { rows: Device[] };
  projectOptions: { rows: Project[] };
  models: { rows: ModelOption[] };
  tools: { rows: Tool[] };
  modelPrices: { rows: ModelPrice[] };
};

export type EventPage = {
  limit: number;
  offset: number;
  sortBy: EventSortBy;
  sortDir: SortDir;
};

export type ProjectSortRequest = {
  sortBy: ProjectSortBy;
  sortDir: SortDir;
};

export type TaskPage = {
  limit: number;
  offset: number;
  sortBy: TaskSortBy;
  sortDir: SortDir;
};

export class ApiError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number) {
    super(`${method} ${path} failed: ${status}`);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "include" });
  if (!response.ok) throw new ApiError("GET", path, response.status);
  return response.json() as Promise<T>;
}

export async function login(email: string, password: string): Promise<void> {
  const response = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password })
  });
  if (!response.ok) throw new ApiError("POST", "/api/admin/login", response.status);
}

export async function logout(): Promise<void> {
  const response = await fetch("/api/admin/logout", {
    method: "POST",
    credentials: "include"
  });
  if (!response.ok) throw new ApiError("POST", "/api/admin/logout", response.status);
}

export async function saveModelPrice(input: ModelPriceInput): Promise<ModelPrice> {
  const response = await fetch("/api/admin/model-prices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input)
  });
  if (!response.ok) throw new ApiError("POST", "/api/admin/model-prices", response.status);
  return response.json() as Promise<ModelPrice>;
}

export async function deleteModelPrice(id: string): Promise<void> {
  const path = `/api/admin/model-prices/${id}`;
  const response = await fetch(path, {
    method: "DELETE",
    credentials: "include"
  });
  if (!response.ok) throw new ApiError("DELETE", path, response.status);
}

export async function getSession(): Promise<Session> {
  return apiGet<Session>("/api/admin/me");
}

export async function getUsageSummary(filters: UsageFilters): Promise<UsageSummary> {
  return apiGet<UsageSummary>(`/api/admin/summary${toQueryString(filters)}`);
}

export async function getDashboardData(
  filters: UsageFilters,
  page: EventPage,
  projectSort: ProjectSortRequest,
  taskPage: TaskPage = {
    limit: 25,
    offset: 0,
    sortBy: "lastActivityAt",
    sortDir: "desc"
  }
): Promise<DashboardData> {
  const query = toQueryString(filters);
  const eventQuery = appendQuery(
    query,
    `limit=${page.limit}&offset=${page.offset}&sortBy=${page.sortBy}&sortDir=${page.sortDir}`
  );
  const projectQuery = appendQuery(query, `sortBy=${projectSort.sortBy}&sortDir=${projectSort.sortDir}`);
  const taskQuery = appendQuery(
    query,
    `limit=${taskPage.limit}&offset=${taskPage.offset}&sortBy=${taskPage.sortBy}&sortDir=${taskPage.sortDir}`
  );
  const deviceOptionsQuery = toQueryString(withoutKeys(filters, ["deviceId"]));
  const projectOptionsQuery = toQueryString(withoutKeys(filters, ["projectId"]));
  const projectRatioQuery = toQueryString(withoutKeys(filters, ["projectId"]));
  const modelQuery = toQueryString(withoutKeys(filters, ["model"]));
  const [
    summary,
    trends,
    projectRatios,
    events,
    tasks,
    devices,
    projects,
    deviceOptions,
    projectOptions,
    models,
    tools,
    modelPrices
  ] = await Promise.all([
      apiGet<UsageSummary>(`/api/admin/summary${query}`),
      apiGet<{ points: TrendPoint[] }>(`/api/admin/trends${query}`),
      apiGet<ProjectRatioResponse>(`/api/admin/project-ratios${projectRatioQuery}`),
      apiGet<{ rows: UsageEvent[]; total: number }>(`/api/admin/events${eventQuery}`),
      apiGet<{ rows: TaskUsage[]; total: number }>(`/api/admin/tasks${taskQuery}`),
      apiGet<{ rows: Device[] }>(`/api/admin/devices${query}`),
      apiGet<{ rows: Project[] }>(`/api/admin/projects${projectQuery}`),
      apiGet<{ rows: Device[] }>(`/api/admin/devices${deviceOptionsQuery}`),
      apiGet<{ rows: Project[] }>(`/api/admin/projects${projectOptionsQuery}`),
      apiGet<{ rows: ModelOption[] }>(`/api/admin/models${modelQuery}`),
      apiGet<{ rows: Tool[] }>("/api/admin/tools"),
      apiGet<{ rows: ModelPrice[] }>("/api/admin/model-prices")
    ]);

  return {
    summary,
    trends,
    projectRatios,
    events,
    tasks,
    devices,
    projects,
    deviceOptions,
    projectOptions,
    models,
    tools,
    modelPrices
  };
}

function appendQuery(query: string, extra: string): string {
  return `${query}&${extra}`;
}

function toQueryString(filters: UsageFilters): string {
  const params = new URLSearchParams();
  params.set("from", filters.from);
  params.set("to", filters.to);
  setOptional(params, "tool", filters.tool);
  setOptional(params, "deviceId", filters.deviceId);
  setOptional(params, "projectId", filters.projectId);
  setOptional(params, "model", filters.model);
  params.set("timeZone", filters.timeZone);
  return `?${params.toString()}`;
}

function withoutKeys<T extends keyof UsageFilters>(filters: UsageFilters, keys: T[]): UsageFilters {
  const next = { ...filters };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function setOptional(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value) {
    params.set(key, value);
  }
}
