import zh from "./zh.js";
import ja from "./ja.js";
import ko from "./ko.js";
import type { Language } from "../dashboard-types.js";

const en: Record<string, string> = {
  "Tool ratio": "Tool share",
  "Project ratio": "Project share",
  "Token ratio": "Token share",
  "Cost ratio": "Cost share",
  "Input ratio": "Input share",
  "Output ratio": "Output share",
  "Cache ratio": "Cache share",
  "Input cost ratio": "Input cost share",
  "Output cost ratio": "Output cost share",
  "Cache cost ratio": "Cache cost share"
};

export const translations: Record<Language, Record<string, string>> = {
  en,
  zh,
  ja,
  ko
};
