import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  initialCodexContext,
  parserAdapters,
  parseCodexFile,
  parseCodexLine,
  parseCodexVsCodeLine,
  parseCodexVsCodeFile
} from "./index.js";
import { sha256Hex } from "@codex-usage-dashboard/shared";

describe("Codex parser adapters", () => {
  it("preserves Codex context and IDs across incremental calls", async () => {
    const contents = currentSession({ source: "cli", originator: "codex-tui" });
    const filePath = await writeFixture("incremental.jsonl", contents);
    const expected = await parseCodexFile(filePath);
    const incremental = [];
    let context = initialCodexContext();

    for (const [index, line] of contents.split(/\r?\n/).entries()) {
      const result = await parseCodexLine({
        line,
        lineNumber: index + 1,
        context,
        sourceIdentity: "unused",
        filePath,
        finalTail: false
      });
      context = result.context;
      if (result.event) incremental.push(result.event);
    }

    expect(incremental).toEqual(expected);
  });

  it("keeps VS Code source identity after rename", async () => {
    const line =
      "2026-05-30 22:21:57.502Z [info] ephemeral_generation_token_usage cachedInputTokens=1536 event=ephemeral_generation_token_usage feature=coding_turn inputTokens=13321 model=gpt-5.5 outputTokens=94 totalTokens=13415";
    const originalPath = "/logs/window1/openai.chatgpt/Codex.log";
    const renamedPath = "/logs/window1/openai.chatgpt/Codex.1.log";
    const sourceIdentity = sha256Hex(`path:${originalPath}`);
    const context = {};
    const before = await parseCodexVsCodeLine({
      line, lineNumber: 1, context, sourceIdentity, filePath: originalPath, finalTail: false
    });
    const after = await parseCodexVsCodeLine({
      line, lineNumber: 1, context, sourceIdentity, filePath: renamedPath, finalTail: false
    });

    expect(after.event?.sourceEventId).toBe(before.event?.sourceEventId);
    expect(after.event?.metadata.sourceFileHash).toBe(sourceIdentity);
  });

  it("returns only a category and hash for malformed target records", async () => {
    const codex = await parseCodexLine({
      line: JSON.stringify({
        timestamp: "2026-05-30T07:00:03.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: -1 } } }
      }),
      lineNumber: 9,
      context: { ...initialCodexContext(), cwd: "/private/workspace" },
      sourceIdentity: "source",
      filePath: "/private/session.jsonl",
      finalTail: false
    });
    const vscode = await parseCodexVsCodeLine({
      line: "2026-05-30 22:21:57.502Z ephemeral_generation_token_usage event=ephemeral_generation_token_usage inputTokens=invalid",
      lineNumber: 3,
      context: {},
      sourceIdentity: "source",
      filePath: "/private/Codex.log",
      finalTail: false
    });

    expect(codex.event).toBeUndefined();
    expect(codex.malformed).toMatchObject({ category: "codex-token-record-invalid" });
    expect(vscode.event).toBeUndefined();
    expect(vscode.malformed).toMatchObject({ category: "codex-vscode-token-record-invalid" });
    expect(JSON.stringify([codex.malformed, vscode.malformed])).not.toContain("private");
  });

  it("parses a complete rotated final tail without requiring a newline", async () => {
    const line = JSON.stringify({
      timestamp: "2026-05-30T10:00:00.000Z",
      session_id: "rotated",
      cwd: "/workspace/projects/example",
      usage: { input_tokens: 7, output_tokens: 3 }
    });
    const result = await parseCodexLine({
      line,
      lineNumber: 4,
      context: initialCodexContext(),
      sourceIdentity: "rotated-source",
      filePath: "/logs/rotated.jsonl",
      finalTail: true
    });

    expect(result.event).toMatchObject({ toolSlug: "codex-cli", inputTokens: 7, outputTokens: 3 });
  });

  it("registers only the two configured filesystem inputs", () => {
    expect(parserAdapters.map(({ slug }) => slug)).toEqual([
      "codex-cli",
      "codex-vscode-plugin"
    ]);
  });

  it("classifies CLI, VS Code, and Desktop as independent event types", async () => {
    const cli = await parseCodexFile(
      await writeFixture("cli.jsonl", currentSession({ source: "cli", originator: "codex-tui" }))
    );
    const vscode = await parseCodexFile(
      await writeFixture(
        "vscode.jsonl",
        currentSession({ source: "vscode", originator: "codex_vscode" })
      )
    );
    const desktop = await parseCodexFile(
      await writeFixture(
        "desktop.jsonl",
        currentSession({ source: "vscode", originator: "Codex Desktop" })
      )
    );

    expect(cli).toMatchObject([{ toolSlug: "codex-cli" }]);
    expect(vscode).toMatchObject([{ toolSlug: "codex-vscode-plugin" }]);
    expect(desktop).toMatchObject([{ toolSlug: "codex-desktop" }]);
    expect(desktop[0]?.toolSlug).not.toBe("codex-vscode-plugin");
  });

  it("classifies current session events with an unknown origin as other", async () => {
    const events = await parseCodexFile(
      await writeFixture(
        "unknown.jsonl",
        currentSession({ source: "unknown", originator: "unknown-client" })
      )
    );

    expect(events).toMatchObject([{ toolSlug: "other" }]);
    expect(events[0]?.taskId).toBe("unknown-client-session");
  });

  it("parses legacy Codex CLI usage without leaking paths or content", async () => {
    const record = {
      timestamp: "2026-05-30T01:00:00.000Z",
      session_id: "session-1",
      cwd: "/workspace/projects/example",
      model: "gpt-5",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 10,
        cache_write_tokens: 5
      },
      prompt: "private prompt",
      response: "private response"
    };

    const events = await parseCodexFile(
      await writeFixture("legacy.jsonl", `${JSON.stringify(record)}\n`)
    );

    expect(events).toMatchObject([
      {
        toolSlug: "codex-cli",
        taskId: "session-1",
        occurredAt: "2026-05-30T01:00:00.000Z",
        model: "gpt-5",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        totalTokens: 165
      }
    ]);
    expect(events[0]?.project.displayName).toBe("example");
    expect(JSON.stringify(events)).not.toContain("/workspace/projects/example");
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("parses official Codex VS Code token logs with cache normalization", async () => {
    const line =
      "2026-05-30 22:21:57.502Z [info] ephemeral_generation_token_usage cachedInputTokens=1536 event=ephemeral_generation_token_usage feature=coding_turn inputTokens=13321 model=gpt-5.5 outputTokens=94 totalTokens=13415";
    const filePath = await writeFixture(
      path.join("Code", "logs", "window1", "exthost", "openai.chatgpt", "Codex.log"),
      `${line}\n`
    );

    const events = await parseCodexVsCodeFile(filePath);

    expect(events).toMatchObject([
      {
        toolSlug: "codex-vscode-plugin",
        occurredAt: "2026-05-30T22:21:57.502Z",
        model: "gpt-5.5",
        inputTokens: 11785,
        outputTokens: 94,
        cacheReadTokens: 1536,
        cacheWriteTokens: 0,
        totalTokens: 13415,
        project: { displayName: "Codex VS Code" },
        metadata: { sourceType: "codex-vscode-log" }
      }
    ]);
    expect(JSON.stringify(events)).not.toContain(filePath);
  });

  it("ignores VS Code title-generation usage", async () => {
    const line =
      "2026-05-30 22:21:57.502Z [info] ephemeral_generation_token_usage cachedInputTokens=0 event=ephemeral_generation_token_usage feature=thread_title inputTokens=100 model=gpt-5.5 outputTokens=20 totalTokens=120";

    await expect(
      parseCodexVsCodeFile(await writeFixture("Codex.log", `${line}\n`))
    ).resolves.toEqual([]);
  });

  it("generates stable unique IDs without using prompt content", async () => {
    const base = {
      timestamp: "2026-05-30T04:00:00.000Z",
      cwd: "/workspace/projects/example",
      model: "gpt-5",
      usage: { input_tokens: 20, output_tokens: 10 }
    };
    const first = { ...base, session_id: "session-a", prompt: "first private prompt" };
    const second = { ...base, session_id: "session-b", prompt: "second private prompt" };
    const events = await parseCodexFile(
      await writeFixture("stable.jsonl", `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)
    );

    expect(new Set(events.map(({ sourceEventId }) => sourceEventId)).size).toBe(2);
    expect(JSON.stringify(events)).not.toContain("private prompt");
  });

  it("quarantines malformed token values without exposing record content", async () => {
    const record = {
      timestamp: "2026-05-30T07:00:00.000Z",
      session_id: "bad",
      cwd: "/workspace/projects/example",
      usage: { input_tokens: -1, output_tokens: 0 }
    };

    await expect(
      parseCodexFile(await writeFixture("bad-token.jsonl", JSON.stringify(record)))
    ).rejects.toThrow(/Codex record 1 invalid/);
  });

  it("skips malformed JSONL lines while preserving valid records", async () => {
    const valid = {
      timestamp: "2026-05-30T10:00:00.000Z",
      session_id: "valid",
      cwd: "/workspace/projects/example",
      model: "gpt-5",
      usage: { input_tokens: 7, output_tokens: 3, cache_read_tokens: 2, cache_write_tokens: 1 }
    };

    const events = await parseCodexFile(
      await writeFixture("mixed.jsonl", `{"broken"\n${JSON.stringify(valid)}\n`)
    );

    expect(events).toMatchObject([
      {
        toolSlug: "codex-cli",
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        totalTokens: 13
      }
    ]);
  });
});

async function writeFixture(name: string, contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-usage-dashboard-parser-"));
  const filePath = path.join(dir, name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
  return filePath;
}

function currentSession(input: { source: string; originator: string }): string {
  const timestamp = "2026-05-30T07:00:03.000Z";
  return [
    {
      timestamp,
      type: "session_meta",
      payload: {
        id: `${input.originator}-session`,
        cwd: "/workspace/projects/example",
        source: input.source,
        originator: input.originator
      }
    },
    {
      timestamp,
      type: "turn_context",
      payload: { cwd: "/workspace/projects/example", model: "gpt-5.5" }
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 25,
            output_tokens: 40,
            total_tokens: 140
          }
        }
      }
    }
  ].map(JSON.stringify).join("\n");
}
