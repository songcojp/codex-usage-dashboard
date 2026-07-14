import { parseCodexVsCodeFile, parseCodexVsCodeLine, type CodexVsCodeParserContext } from "./codex-vscode.js";
import { initialCodexContext, parseCodexFile, parseCodexLine, type CodexParserContext } from "./codex.js";
import type { IncrementalParserAdapter } from "./types.js";
import fs from "node:fs/promises";
import path from "node:path";

export { parseCodexVsCodeFile, parseCodexVsCodeLine } from "./codex-vscode.js";
export { initialCodexContext, parseCodexFile, parseCodexLine } from "./codex.js";
export type { IncrementalParserAdapter, ParseLineInput, ParseLineResult, ParserAdapter } from "./types.js";

export const parserAdapters: Array<
  IncrementalParserAdapter<CodexParserContext> | IncrementalParserAdapter<CodexVsCodeParserContext>
> = [
  { slug: "codex-cli", parseFile: parseCodexFile, discoverFiles: discoverCodexSessionFiles, initialContext: initialCodexContext, parseLine: parseCodexLine },
  {
    slug: "codex-vscode-plugin",
    parseFile: parseCodexVsCodeFile,
    discoverFiles: discoverCodexVsCodeFiles,
    initialContext: () => ({}),
    parseLine: parseCodexVsCodeLine
  }
];

async function discoverCodexSessionFiles(sourcePath: string): Promise<string[]> {
  return discoverFiles(sourcePath, (filePath) => filePath.endsWith(".jsonl"));
}

async function discoverCodexVsCodeFiles(sourcePath: string): Promise<string[]> {
  return discoverFiles(sourcePath, (filePath) => {
    const normalized = filePath.split(path.sep).join("/");
    return /\/openai\.chatgpt\/Codex(?:\.\d+)?\.log$/.test(normalized);
  });
}

async function discoverFiles(sourcePath: string, includeFile: (filePath: string) => boolean): Promise<string[]> {
  const stat = await fs.stat(sourcePath);
  if (stat.isFile()) {
    return includeFile(sourcePath) ? [sourcePath] : [];
  }

  if (!stat.isDirectory()) {
    return [];
  }

  const files: string[] = [];
  await walk(sourcePath, includeFile, files);
  return files.sort();
}

async function walk(dirPath: string, includeFile: (filePath: string) => boolean, files: string[]): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath, includeFile, files);
    } else if (entry.isFile() && includeFile(entryPath)) {
      files.push(entryPath);
    }
  }
}
