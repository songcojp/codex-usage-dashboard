import fs from "node:fs/promises";
import { sha256Hex, usageEventDraftSchema, type UsageEventDraft } from "@codex-usage-dashboard/shared";
import { identityFromPathParts } from "../project.js";
import { normalizeTimestampUtc } from "./timestamp.js";

const ignoredEphemeralFeatures = new Set(["thread_title"]);

export async function parseCodexVsCodeFile(filePath: string): Promise<UsageEventDraft[]> {
  const contents = await fs.readFile(filePath, "utf8");
  const events: UsageEventDraft[] = [];

  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed.includes("ephemeral_generation_token_usage") || shouldIgnoreTokenUsageLine(trimmed)) {
      continue;
    }

    events.push(parseTokenUsageLine(filePath, trimmed, index + 1));
  }

  return events;
}

function shouldIgnoreTokenUsageLine(line: string): boolean {
  const fields = keyValueFields(line.split(/\s+/));
  return fields.event === "ephemeral_generation_token_usage" && ignoredEphemeralFeatures.has(fields.feature ?? "");
}

function parseTokenUsageLine(filePath: string, line: string, recordNumber: number): UsageEventDraft {
  const occurredAt = parseTimestamp(line, recordNumber);
  const fields = keyValueFields(line.split(/\s+/));
  const rawInputTokens = tokenCount(fields.inputTokens, `Codex VS Code record ${recordNumber} inputTokens`);
  const cacheReadTokens = tokenCount(fields.cachedInputTokens, `Codex VS Code record ${recordNumber} cachedInputTokens`);
  const outputTokens = tokenCount(fields.outputTokens, `Codex VS Code record ${recordNumber} outputTokens`);
  const inputTokens = Math.max(0, rawInputTokens - cacheReadTokens);
  const sourceFileHash = sha256Hex(`path:${filePath}`);
  const sourceIdBasis = `codex-vscode-plugin:${sourceFileHash}:${occurredAt}:${recordNumber}:${fields.feature ?? ""}`;

  return usageEventDraftSchema.parse({
    sourceEventId: sha256Hex(sourceIdBasis),
    toolSlug: "codex-vscode-plugin",
    occurredAt,
    project: identityFromPathParts({ cwd: "Codex VS Code" }),
    model: fields.model ?? null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    totalTokens: fields.totalTokens === undefined
      ? inputTokens + outputTokens + cacheReadTokens
      : tokenCount(fields.totalTokens, `Codex VS Code record ${recordNumber} totalTokens`),
    costUsd: null,
    metadata: {
      sourceType: "codex-vscode-log",
      sourceRecordHash: sha256Hex(sourceIdBasis),
      sourceFileHash,
      feature: fields.feature ?? null,
      lineNumber: recordNumber
    }
  });
}

function parseTimestamp(line: string, recordNumber: number): string {
  const match = line.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:?\d{2})?)\b/);
  if (!match) {
    throw new Error(`Codex VS Code record ${recordNumber} timestamp must be present`);
  }
  return normalizeTimestampUtc(`${match[1]}T${match[2]}`, `Codex VS Code record ${recordNumber} timestamp`);
}

function keyValueFields(parts: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of parts) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex > 0) {
      fields[part.slice(0, separatorIndex)] = part.slice(separatorIndex + 1);
    }
  }
  return fields;
}

function tokenCount(value: string | undefined, fieldName: string): number {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw new Error(`${fieldName} must be a nonnegative integer`);
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw new Error(`${fieldName} must be a nonnegative integer`);
}
