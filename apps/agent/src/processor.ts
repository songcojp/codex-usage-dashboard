import os from "node:os";
import { sha256Hex, type IngestBatch, type UsageEventDraft } from "@codex-usage-dashboard/shared";
import type { AgentConfig } from "./config.js";
import { readLineChunk, type LineCursor } from "./line-reader.js";
import { initialCodexContext, parseCodexLine, parseCodexVsCodeLine } from "./parsers/index.js";
import type { CodexParserContext } from "./parsers/codex.js";
import { DurableQueue } from "./queue.js";
import { readAgentState, writeAgentState, type FileCursorState, type ParserState } from "./state.js";
import { uploadIngestBatch } from "./upload.js";

const defaultReadBytes = 4 * 1024 * 1024;
const defaultMaxEvents = 500;

export type QueuePort = {
  readonly depth: number;
  readonly sizeBytes: number;
  readonly maxBytes: number;
  enqueue(events: UsageEventDraft[]): Promise<number>;
};

export type ProcessSourceResult = {
  queued: number;
  malformed: number;
  advancedLines: number;
  remaining: number;
};

export async function processSourceFile(input: {
  filePath: string;
  identity: string;
  parserSlug: "codex-cli" | "codex-vscode-plugin";
  statePath: string;
  queue: QueuePort;
  maxReadBytes?: number;
  maxEvents?: number;
  now?: () => Date;
  finalTail?: boolean;
}): Promise<ProcessSourceResult> {
  const state = await readAgentState(input.statePath);
  const tracked = state.files[input.identity];
  if (!tracked) throw new Error(`source identity is not tracked: ${input.identity}`);
  const startingLine = tracked.nextLineNumber;
  const framed = await readLineChunk({
    filePath: input.filePath,
    cursor: toLineCursor(tracked),
    maxBytes: input.maxReadBytes ?? defaultReadBytes,
    expectedIdentity: tracked.identity,
    finalTail: input.finalTail ?? tracked.finalizeAtEof ?? false
  });

  let parserContext = restoreParserContext(tracked.parser, input.parserSlug);
  let acceptedCursor: LineCursor = toLineCursor(tracked);
  let acceptedParser = tracked.parser;
  let eventBytes = 0;
  let malformed = framed.discarded.length;
  const events: UsageEventDraft[] = [];
  let stopped = false;

  for (const frame of framed.lines) {
    const result = input.parserSlug === "codex-cli"
      ? await parseCodexLine({
          line: frame.text,
          lineNumber: frame.lineNumber,
          context: parserContext as CodexParserContext,
          sourceIdentity: tracked.sourceIdentity,
          filePath: input.filePath,
          finalTail: Boolean(frame.finalTail)
        })
      : await parseCodexVsCodeLine({
          line: frame.text,
          lineNumber: frame.lineNumber,
          context: {},
          sourceIdentity: tracked.sourceIdentity,
          filePath: input.filePath,
          finalTail: Boolean(frame.finalTail)
        });

    const nextContext = input.parserSlug === "codex-cli" ? result.context : {};
    if (result.event) {
      const bytes = Buffer.byteLength(`${JSON.stringify(result.event)}\n`);
      if (events.length >= (input.maxEvents ?? defaultMaxEvents) ||
          input.queue.sizeBytes + eventBytes + bytes > input.queue.maxBytes) {
        stopped = true;
        break;
      }
      events.push(result.event);
      eventBytes += bytes;
    }
    if (result.malformed) malformed += 1;
    parserContext = nextContext;
    acceptedCursor = frame.checkpoint;
    acceptedParser = persistParserContext(input.parserSlug, parserContext);
  }

  if (!stopped && framed.lines.length === 0 || !stopped && acceptedCursor.offset === framed.lines.at(-1)?.checkpoint.offset) {
    acceptedCursor = framed.cursor;
  }

  const cursorAdvanced = acceptedCursor.offset !== tracked.offset ||
    acceptedCursor.nextLineNumber !== tracked.nextLineNumber ||
    acceptedCursor.pendingBase64 !== tracked.pendingBase64 ||
    acceptedCursor.discardUntilNewline !== tracked.discardUntilNewline;

  const queued = events.length > 0 ? await input.queue.enqueue(events) : 0;
  if (cursorAdvanced) {
    state.files[input.identity] = {
      ...tracked,
      ...acceptedCursor,
      parser: acceptedParser,
      observedSize: framed.observedSize,
      observedMtimeMs: framed.observedMtimeMs,
      missingReconciliations: 0,
      finalizeAtEof: (input.finalTail ?? tracked.finalizeAtEof ?? false) && acceptedCursor.pendingBase64 !== ""
    };
    state.lastSourceAdvanceAt = (input.now ?? (() => new Date()))().toISOString();
    if (malformed > 0) state.lastErrorCategory = "malformed-source-record";
    state.queueDepth = input.queue.depth;
    await writeAgentState(state, input.statePath);
  }

  return {
    queued,
    malformed,
    advancedLines: acceptedCursor.nextLineNumber - startingLine,
    remaining: Math.max(0, framed.observedSize - acceptedCursor.offset)
  };
}

export async function drainUploadQueue(input: {
  queue: DurableQueue;
  config: AgentConfig;
  statePath: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  signal?: AbortSignal;
}): Promise<{ uploaded: number; rejected: number; remaining: number; status: number | null }> {
  const sent = await input.queue.peek(500);
  if (sent.length === 0) return { uploaded: 0, rejected: 0, remaining: 0, status: null };
  const result = await uploadIngestBatch({
    serverUrl: input.config.serverUrl,
    deviceToken: input.config.deviceToken,
    batch: createIngestBatch(input.config, sent),
    fetchImpl: input.fetchImpl,
    signal: input.signal
  });
  if (!result.ok) {
    return { uploaded: 0, rejected: 0, remaining: input.queue.depth, status: result.status };
  }
  const acknowledgement = result.body as { inserted: number; duplicates: number; rejected: Array<{ sourceEventId: string; reason: string }> };
  await input.queue.acknowledge(sent, acknowledgement);
  const state = await readAgentState(input.statePath);
  state.lastUploadAt = (input.now ?? (() => new Date()))().toISOString();
  state.queueDepth = input.queue.depth;
  state.lastErrorCategory = null;
  await writeAgentState(state, input.statePath);
  return {
    uploaded: result.acknowledgement?.accepted.length ?? 0,
    rejected: result.acknowledgement?.rejected.length ?? 0,
    remaining: input.queue.depth,
    status: result.status
  };
}

function toLineCursor(file: FileCursorState): LineCursor {
  return {
    offset: file.offset,
    nextLineNumber: file.nextLineNumber,
    pendingBase64: file.pendingBase64,
    discardUntilNewline: file.discardUntilNewline
  };
}

function restoreParserContext(
  parser: ParserState,
  slug: "codex-cli" | "codex-vscode-plugin"
): CodexParserContext | Record<string, never> {
  if (slug === "codex-vscode-plugin") return {};
  const initial = initialCodexContext();
  return {
    ...initial,
    sessionId: parser.sessionId ?? null,
    cwd: parser.cwd ?? null,
    model: parser.model ?? null,
    toolSlug: parser.toolSlug ?? "other"
  };
}

function persistParserContext(
  slug: "codex-cli" | "codex-vscode-plugin",
  context: CodexParserContext | Record<string, never>
): ParserState {
  return slug === "codex-vscode-plugin"
    ? { kind: "codex-vscode" }
    : { kind: "codex-jsonl", ...(context as CodexParserContext) };
}

function createIngestBatch(config: AgentConfig, events: UsageEventDraft[]): IngestBatch {
  return {
    device: {
      name: config.deviceName,
      os: `${process.platform}:${process.arch}`,
      hostnameHash: sha256Hex(`hostname:${os.hostname()}`)
    },
    events
  };
}
