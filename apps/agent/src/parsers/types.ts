import type { UsageEventDraft } from "@codex-usage-dashboard/shared";

export type ParserAdapter = {
  slug: string;
  parseFile(filePath: string): Promise<UsageEventDraft[]>;
  discoverFiles?(sourcePath: string): Promise<string[]>;
};
