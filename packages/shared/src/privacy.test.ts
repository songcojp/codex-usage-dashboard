import { describe, expect, it } from "vitest";
import { assertSanitizedMetadata } from "./privacy.js";
import { ingestBatchSchema, usageEventDraftSchema } from "./schemas.js";

const linuxHomePath = ["/ho", "me/alice"].join("");
const macHomePath = ["/Us", "ers/alice"].join("");
const windowsHomePath = ["C:\\Us", "ers\\alice"].join("");

const validUsageEventDraft = {
  sourceEventId: "event-123456",
  toolSlug: "codex-cli",
  occurredAt: "2026-05-30T08:00:00.000Z",
  project: {
    displayName: "codex-usage-dashboard",
    repoHash: null,
    remoteHash: null,
    pathHash: "0123456789abcdef"
  },
  model: null,
  totalTokens: 42
} as const;

describe("assertSanitizedMetadata", () => {
  it("rejects prompt and response text keys", () => {
    expect(() => assertSanitizedMetadata({ prompt: "secret" })).toThrow("content key");
    expect(() => assertSanitizedMetadata({ response: "secret" })).toThrow("content key");
  });

  it("rejects content keys case-insensitively", () => {
    expect(() => assertSanitizedMetadata({ Messages: "secret" })).toThrow("content key");
    expect(() => assertSanitizedMetadata({ TRANSCRIPT: "secret" })).toThrow("content key");
  });

  it("rejects full local paths", () => {
    expect(() => assertSanitizedMetadata({ sourcePath: `${linuxHomePath}/project/file.jsonl` })).toThrow("local path");
    expect(() => assertSanitizedMetadata({ sourcePath: `${windowsHomePath}\\project\\file.jsonl` })).toThrow(
      "local path"
    );
  });

  it("rejects broader full local path variants", () => {
    expect(() => assertSanitizedMetadata({ sourcePath: "/etc/passwd" })).toThrow("local path");
    expect(() => assertSanitizedMetadata({ sourcePath: "/workspace/codex-usage-dashboard/session.jsonl" })).toThrow(
      "local path"
    );
    expect(() => assertSanitizedMetadata({ sourceUri: `file://${linuxHomePath}/session.jsonl` })).toThrow("local path");
    expect(() => assertSanitizedMetadata({ sourcePath: windowsHomePath.toLowerCase() + "\\session.jsonl" })).toThrow("local path");
    expect(() => assertSanitizedMetadata({ source: `source='${linuxHomePath}/project/file.jsonl'` })).toThrow(
      "local path"
    );
    expect(() => assertSanitizedMetadata({ source: `(${linuxHomePath}/project/file.jsonl)` })).toThrow("local path");
  });

  it("rejects normalized content key variants", () => {
    expect(() => assertSanitizedMetadata({ promptText: "secret" })).toThrow("content key");
    expect(() => assertSanitizedMetadata({ response_text: "secret" })).toThrow("content key");
    expect(() => assertSanitizedMetadata({ rawPrompt: "secret" })).toThrow("content key");
    expect(() => assertSanitizedMetadata({ conversationId: "secret" })).toThrow("content key");
    expect(() => assertSanitizedMetadata({ completion_text: "secret" })).toThrow("content key");
  });

  it("rejects nested content keys", () => {
    expect(() => assertSanitizedMetadata({ details: { transcript: "secret" } })).toThrow("content key");
    expect(() => assertSanitizedMetadata({ spans: [{ message: "secret" }] })).toThrow("content key");
  });

  it("rejects nested full local paths", () => {
    expect(() => assertSanitizedMetadata({ details: { sourcePath: `${macHomePath}/project/file.jsonl` } })).toThrow(
      "local path"
    );
    expect(() =>
      assertSanitizedMetadata({ spans: [{ sourcePath: `${windowsHomePath}\\project\\file.jsonl` }] })
    ).toThrow("local path");
  });

  it("allows scanner metadata", () => {
    expect(() =>
      assertSanitizedMetadata({ scannerVersion: "0.1.0", sourceType: "codex-session", sessionHash: "abc123" })
    ).not.toThrow();
  });
});

describe("usage schemas", () => {
  it("rejects unsafe metadata at schema boundaries", () => {
    expect(() => usageEventDraftSchema.parse({ ...validUsageEventDraft, metadata: { prompt: "secret" } })).toThrow(
      "content key"
    );
    expect(() =>
      usageEventDraftSchema.parse({ ...validUsageEventDraft, metadata: { promptText: "secret" } })
    ).toThrow("content key");
  });

  it("rejects nested unsafe metadata at schema boundaries", () => {
    expect(() =>
      ingestBatchSchema.parse({
        device: { name: "Workstation", os: "linux", hostnameHash: "0123456789abcdef" },
        events: [
          {
            ...validUsageEventDraft,
            metadata: { details: [{ sourcePath: "/tmp/codex-usage-dashboard/session.jsonl" }] }
          }
        ]
      })
    ).toThrow("local path");

    expect(() =>
      usageEventDraftSchema.parse({
        ...validUsageEventDraft,
        metadata: { details: [{ sourceUri: `file://${linuxHomePath}/session.jsonl` }] }
      })
    ).toThrow("local path");
  });

  it("accepts sanitized metadata and applies defaults", () => {
    const parsed = usageEventDraftSchema.parse({
      ...validUsageEventDraft,
      metadata: { scannerVersion: "0.1.0", nested: [{ sourceType: "codex-session" }] }
    });

    expect(parsed.inputTokens).toBe(0);
    expect(parsed.outputTokens).toBe(0);
    expect(parsed.cacheReadTokens).toBe(0);
    expect(parsed.cacheWriteTokens).toBe(0);
    expect(parsed.costUsd).toBeNull();
    expect(parsed.metadata).toEqual({ scannerVersion: "0.1.0", nested: [{ sourceType: "codex-session" }] });

    expect(usageEventDraftSchema.parse(validUsageEventDraft).metadata).toEqual({});
  });
});
