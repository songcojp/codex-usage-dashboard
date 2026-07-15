import zh from "./zh.js";
import ja from "./ja.js";
import ko from "./ko.js";
import type { Language } from "../dashboard-types.js";

export const translations: Record<Language, Record<string, string>> = {
  en: {},
  zh,
  ja,
  ko
};
