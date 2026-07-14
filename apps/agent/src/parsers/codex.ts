import fs from "node:fs/promises";
import { sha256Hex, usageEventDraftSchema, type ToolSlug, type UsageEventDraft } from "@codex-usage-dashboard/shared";
import { identityFromCwd } from "../project.js";

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

export async function parseCodexFile(filePath: string): Promise<UsageEventDraft[]> {
  const contents = await fs.readFile(filePath, "utf8");
  const events: UsageEventDraft[] = [];
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  let toolSlug: Extract<ToolSlug, "codex-vscode-plugin" | "codex-desktop" | "codex-cli" | "other"> = "other";

  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let record: CodexUsageRecord;
    try {
      record = JSON.parse(trimmed) as CodexUsageRecord;
    } catch (error) {
      continue;
    }

    if (isLegacyUsageRecord(record)) {
      events.push(await parseLegacyUsageRecord(record, index + 1));
      continue;
    }

    const sessionRecord = record as CodexSessionRecord;
    const payload = objectValue(sessionRecord.payload);

    if (sessionRecord.type === "session_meta") {
      sessionId = optionalString(payload?.id) ?? sessionId;
      cwd = optionalString(payload?.cwd) ?? cwd;
      toolSlug = classifyCodexSessionTool(payload) ?? toolSlug;
      continue;
    }

    if (sessionRecord.type === "turn_context") {
      cwd = optionalString(payload?.cwd) ?? cwd;
      model = optionalString(payload?.model) ?? model;
      continue;
    }

    if (sessionRecord.type !== "event_msg" || payload?.type !== "token_count") {
      continue;
    }

    const info = objectValue(payload.info);
    const usage = objectValue(info?.last_token_usage);
    if (!usage) {
      continue;
    }

    const activeCwd = requiredString(cwd, `Codex record ${index + 1} cwd`);
    const occurredAt = requiredString(sessionRecord.timestamp, `Codex record ${index + 1} timestamp`);
    const rawInputTokens = tokenCount(usage.input_tokens, `Codex record ${index + 1} input_tokens`);
    const cacheReadTokens = tokenCount(
      usage.cached_input_tokens,
      `Codex record ${index + 1} cached_input_tokens`
    );
    const inputTokens = Math.max(0, rawInputTokens - cacheReadTokens);
    const outputTokens = tokenCount(usage.output_tokens, `Codex record ${index + 1} output_tokens`);
    const cacheWriteTokens = 0;
    const sourceIdBasis = `${toolSlug}:${occurredAt}:${sessionId ?? ""}:${index + 1}`;

    events.push(
      usageEventDraftSchema.parse({
        sourceEventId: sha256Hex(sourceIdBasis),
        toolSlug,
        occurredAt,
        project: await identityFromCwd({ cwd: activeCwd }),
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        costUsd: null,
        metadata: {
          sourceType: "codex-session-token-count",
          sourceRecordHash: sha256Hex(sourceIdBasis),
          lineNumber: index + 1
        }
      })
    );
  }

  return events;
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
