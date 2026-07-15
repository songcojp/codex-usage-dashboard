import fs from "node:fs/promises";
import { sha256Hex, usageEventDraftSchema, type ToolSlug, type UsageEventDraft } from "@codex-usage-dashboard/shared";
import { identityFromCwd } from "../project.js";
import type { ParseLineInput, ParseLineResult } from "./types.js";

type CodexUsageRecord = {
  timestamp?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  model?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_tokens?: unknown;
    cache_write_tokens?: unknown;
  };
};

type CodexSessionRecord = {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
};

export type CodexParserContext = {
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  toolSlug: Extract<ToolSlug, "codex-vscode-plugin" | "codex-desktop" | "codex-cli" | "other">;
};

export function initialCodexContext(): CodexParserContext {
  return { sessionId: null, cwd: null, model: null, toolSlug: "other" };
}

export async function parseCodexFile(filePath: string): Promise<UsageEventDraft[]> {
  const contents = await fs.readFile(filePath, "utf8");
  const events: UsageEventDraft[] = [];
  let context = initialCodexContext();

  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const result = await parseCodexLine({ line, lineNumber: index + 1, context, sourceIdentity: "", filePath, finalTail: false });
    context = result.context;
    if (result.malformed) throw new Error(`Codex record ${index + 1} invalid`);
    if (result.event) events.push(result.event);
  }

  return events;
}

export async function parseCodexLine(
  input: ParseLineInput<CodexParserContext>
): Promise<ParseLineResult<CodexParserContext>> {
  const trimmed = input.line.trim();
  if (!trimmed) return { context: input.context };

  let record: CodexUsageRecord;
  try {
    record = JSON.parse(trimmed) as CodexUsageRecord;
  } catch {
    return input.finalTail
      ? { context: input.context, malformed: { category: "codex-final-tail-invalid", sourceHash: sha256Hex(input.line) } }
      : { context: input.context };
  }

  try {
    if (isLegacyUsageRecord(record)) {
      return { context: input.context, event: await parseLegacyUsageRecord(record, input.lineNumber) };
    }

    const sessionRecord = record as CodexSessionRecord;
    const payload = objectValue(sessionRecord.payload);
    if (sessionRecord.type === "session_meta") {
      return {
        context: {
          ...input.context,
          sessionId: optionalString(payload?.id) ?? input.context.sessionId,
          cwd: optionalString(payload?.cwd) ?? input.context.cwd,
          toolSlug: classifyCodexSessionTool(payload)
        }
      };
    }
    if (sessionRecord.type === "turn_context") {
      return {
        context: {
          ...input.context,
          cwd: optionalString(payload?.cwd) ?? input.context.cwd,
          model: optionalString(payload?.model) ?? input.context.model
        }
      };
    }
    if (sessionRecord.type !== "event_msg" || payload?.type !== "token_count") {
      return { context: input.context };
    }
    const usage = objectValue(objectValue(payload.info)?.last_token_usage);
    if (!usage) return { context: input.context };

    const activeCwd = requiredString(input.context.cwd, `Codex record ${input.lineNumber} cwd`);
    const occurredAt = requiredString(sessionRecord.timestamp, `Codex record ${input.lineNumber} timestamp`);
    const rawInputTokens = tokenCount(usage.input_tokens, `Codex record ${input.lineNumber} input_tokens`);
    const cacheReadTokens = tokenCount(usage.cached_input_tokens, `Codex record ${input.lineNumber} cached_input_tokens`);
    const inputTokens = Math.max(0, rawInputTokens - cacheReadTokens);
    const outputTokens = tokenCount(usage.output_tokens, `Codex record ${input.lineNumber} output_tokens`);
    const sourceIdBasis = `${input.context.toolSlug}:${occurredAt}:${input.context.sessionId ?? ""}:${input.lineNumber}`;
    return {
      context: input.context,
      event: usageEventDraftSchema.parse({
        sourceEventId: sha256Hex(sourceIdBasis),
        taskId: input.context.sessionId,
        toolSlug: input.context.toolSlug,
        occurredAt,
        project: await identityFromCwd({ cwd: activeCwd }),
        model: input.context.model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens: 0,
        totalTokens: inputTokens + outputTokens + cacheReadTokens,
        costUsd: null,
        metadata: { sourceType: "codex-session-token-count", sourceRecordHash: sha256Hex(sourceIdBasis), lineNumber: input.lineNumber }
      })
    };
  } catch {
    return {
      context: input.context,
      malformed: { category: "codex-token-record-invalid", sourceHash: sha256Hex(input.line) }
    };
  }
}

function classifyCodexSessionTool(
  payload: Record<string, unknown> | null
): Extract<ToolSlug, "codex-vscode-plugin" | "codex-desktop" | "codex-cli" | "other"> {
  const source = optionalString(payload?.source)?.toLowerCase();
  const originator = optionalString(payload?.originator)?.toLowerCase();

  if (originator === "codex desktop") {
    return "codex-desktop";
  }

  if (originator === "codex_vscode" || source === "vscode") {
    return "codex-vscode-plugin";
  }

  if (source === "cli" || originator === "codex-tui") {
    return "codex-cli";
  }

  return "other";
}

function isLegacyUsageRecord(record: CodexUsageRecord): boolean {
  return record.usage !== undefined || record.cwd !== undefined || record.session_id !== undefined;
}

async function parseLegacyUsageRecord(record: CodexUsageRecord, recordNumber: number): Promise<UsageEventDraft> {
  const cwd = requiredString(record.cwd, `Codex record ${recordNumber} cwd`);
  const occurredAt = requiredString(record.timestamp, `Codex record ${recordNumber} timestamp`);
  const inputTokens = tokenCount(record.usage?.input_tokens, `Codex record ${recordNumber} input_tokens`);
  const outputTokens = tokenCount(record.usage?.output_tokens, `Codex record ${recordNumber} output_tokens`);
  const cacheReadTokens = tokenCount(
    record.usage?.cache_read_tokens,
    `Codex record ${recordNumber} cache_read_tokens`
  );
  const cacheWriteTokens = tokenCount(
    record.usage?.cache_write_tokens,
    `Codex record ${recordNumber} cache_write_tokens`
  );
  const stableRecordId = optionalString(record.session_id);
  const sourceIdBasis = `codex-cli:${occurredAt}:${stableRecordId ?? ""}:${recordNumber}`;
  const recordHash = sha256Hex(stableRecordId ?? sourceIdBasis);

  return usageEventDraftSchema.parse({
    sourceEventId: sha256Hex(sourceIdBasis),
    taskId: stableRecordId,
    toolSlug: "codex-cli",
    occurredAt,
    project: await identityFromCwd({ cwd }),
    model: optionalString(record.model),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    costUsd: null,
    metadata: {
      sourceType: "codex-jsonl",
      sourceRecordHash: recordHash,
      lineNumber: recordNumber
    }
  });
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function tokenCount(value: unknown, fieldName: string): number {
  if (value === undefined) {
    return 0;
  }

  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  throw new Error(`${fieldName} must be a nonnegative integer`);
}
