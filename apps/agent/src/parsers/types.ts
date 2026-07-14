import type { UsageEventDraft } from "@codex-usage-dashboard/shared";

export type ParserAdapter = {
  slug: string;
  parseFile(filePath: string): Promise<UsageEventDraft[]>;
  discoverFiles?(sourcePath: string): Promise<string[]>;
};

export type ParseLineInput<C> = {
  line: string;
  lineNumber: number;
  context: C;
  sourceIdentity: string;
  filePath: string;
  finalTail: boolean;
};

export type ParseLineResult<C> = {
  context: C;
  event?: UsageEventDraft;
  malformed?: { category: string; sourceHash: string };
};

export interface IncrementalParserAdapter<C> extends ParserAdapter {
  initialContext(): C;
  parseLine(input: ParseLineInput<C>): Promise<ParseLineResult<C>>;
}
