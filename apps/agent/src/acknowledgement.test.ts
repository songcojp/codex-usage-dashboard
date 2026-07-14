import { describe, expect, it } from "vitest";
import { validateAcknowledgement } from "./acknowledgement.js";
import type { UsageEventDraft } from "@codex-usage-dashboard/shared";

describe("acknowledgement validation", () => {
  it("accounts for every sent event", () => {
    const sent = [event("a"), event("b")];
    expect(validateAcknowledgement(sent, {
      inserted: 1,
      duplicates: 0,
      rejected: [{ sourceEventId: "b", reason: "invalid" }]
    })).toMatchObject({ accepted: [sent[0]], rejected: [{ event: sent[1] }] });
  });

  it("rejects unknown or repeated rejected IDs", () => {
    const sent = [event("a"), event("b")];
    expect(() => validateAcknowledgement(sent, {
      inserted: 1, duplicates: 0, rejected: [{ sourceEventId: "unknown", reason: "bad" }]
    })).toThrow(/rejected source event ID/);
    expect(() => validateAcknowledgement(sent, {
      inserted: 0,
      duplicates: 0,
      rejected: [
        { sourceEventId: "a", reason: "bad" },
        { sourceEventId: "a", reason: "bad again" }
      ]
    })).toThrow(/rejected source event ID/);
  });

  it("rejects malformed success bodies", () => {
    expect(() => validateAcknowledgement([event("a")], { accepted: true })).toThrow(/invalid acknowledgement/);
  });

  it("does not retain path-like server reasons", () => {
    const result = validateAcknowledgement([event("a")], {
      inserted: 0,
      duplicates: 0,
      rejected: [{ sourceEventId: "a", reason: "/home/person/private/token" }]
    });
    expect(result.rejected[0]?.reason).toBe("server-rejected");
  });
});

function event(sourceEventId: string): UsageEventDraft {
  return {
    sourceEventId,
    toolSlug: "codex-cli",
    occurredAt: "2026-05-30T00:00:00.000Z",
    project: { displayName: "project", repoHash: "a".repeat(64), remoteHash: null, pathHash: "b".repeat(64) },
    model: null,
    inputTokens: 1,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1,
    costUsd: null,
    metadata: {}
  };
}
