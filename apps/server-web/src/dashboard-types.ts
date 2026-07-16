export type DashboardTab = "events" | "tasks" | "devices" | "projects" | "prices";
export type DashboardSection = "overview" | "trend" | "explorer";
export type Theme = "light" | "dark";
export type Language = "zh" | "ja" | "en" | "ko";
export type LanguageSetting = "auto" | Language;
export type Translate = (key: string) => string;

export type EventSort =
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

export type ProjectSort =
  | "updatedAt-desc"
  | "updatedAt-asc"
  | "eventCount-desc"
  | "eventCount-asc"
  | "totalTokens-desc"
  | "totalTokens-asc"
  | "costUsd-desc"
  | "costUsd-asc";

export type TaskSort =
  | "lastActivityAt-desc"
  | "lastActivityAt-asc"
  | "eventCount-desc"
  | "eventCount-asc"
  | "totalTokens-desc"
  | "totalTokens-asc"
  | "costUsd-desc"
  | "costUsd-asc";

export type PriceDraft = {
  model: string;
  inputCostPerMillionUsd: string;
  outputCostPerMillionUsd: string;
  cacheReadCostPerMillionUsd: string;
  cacheWriteCostPerMillionUsd: string;
};
