import { describe, expect, it } from "vitest";
import { sha256Hex } from "@codex-usage-dashboard/shared";
import {
  ingestValidatedBatch,
  normalizeProjectIdentity,
  summarizeIngestResult,
  validateBatch,
  type IngestStore
} from "./service.js";

const validBatch = {
  device: {
    name: "Workstation",
    os: "linux",
    hostnameHash: "hostname-hash-1234"
  },
  events: [
    {
      sourceEventId: "event-id-123456",
      toolSlug: "codex-cli",
      occurredAt: "2026-05-30T00:00:00.000Z",
      project: {
        displayName: "codex-usage-dashboard",
        repoHash: null,
        remoteHash: null,
        pathHash: "path-hash-123456"
      },
      model: "gpt-5",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      totalTokens: 20,
      costUsd: null,
      metadata: {
        source: "fixture"
      }
    }
  ]
};

describe("summarizeIngestResult", () => {
  it("reports inserted, duplicates, and rejected counts", () => {
    expect(summarizeIngestResult({ inserted: 2, duplicates: 1, rejected: [{ sourceEventId: "bad", reason: "invalid" }] })).toEqual({
      inserted: 2,
      duplicates: 1,
      rejected: [{ sourceEventId: "bad", reason: "invalid" }]
    });
  });
});

describe("validateBatch", () => {
  it("accepts a valid ingestion batch", () => {
    expect(validateBatch(validBatch)).toEqual(validBatch);
  });

  it("accepts aggregate-only token totals when component breakdown is absent", () => {
    const batch = {
      ...validBatch,
      events: [
        {
          ...validBatch.events[0],
          inputTokens: undefined,
          outputTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
          totalTokens: 20
        }
      ]
    };

    const result = validateBatch(batch);

    expect(result.events[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 20
    });
  });

  it("keeps Desktop, VS Code, and unknown sources distinct", () => {
    const result = validateBatch({
      ...validBatch,
      events: [
        {
          ...validBatch.events[0],
          toolSlug: "codex-vscode-plugin"
        },
        {
          ...validBatch.events[0],
          sourceEventId: "event-id-desktop-2",
          toolSlug: "codex-desktop"
        },
        {
          ...validBatch.events[0],
          sourceEventId: "event-id-other-3",
          toolSlug: "other"
        }
      ]
    });

    expect(result.events.map((event) => event.toolSlug)).toEqual([
      "codex-vscode-plugin",
      "codex-desktop",
      "other"
    ]);
  });

  it("rejects mismatched token totals", () => {
    expect(() =>
      validateBatch({
        ...validBatch,
        events: [
          {
            ...validBatch.events[0],
            totalTokens: 19
          }
        ]
      })
    ).toThrow("invalid ingest batch");
  });

  it("rejects unsafe metadata", () => {
    expect(() =>
      validateBatch({
        ...validBatch,
        events: [
          {
            ...validBatch.events[0],
            metadata: {
              prompt: "private content"
            }
          }
        ]
      })
    ).toThrow("invalid ingest batch");
  });
});

describe("normalizeProjectIdentity", () => {
  it("uses empty string sentinels for nullable project hashes", () => {
    expect(
      normalizeProjectIdentity({
        displayName: "codex-usage-dashboard",
        repoHash: null,
        remoteHash: null,
        pathHash: "path-hash-123456"
      })
    ).toEqual({
      displayName: "codex-usage-dashboard",
      repoHash: "",
      remoteHash: "",
      pathHash: "path-hash-123456"
    });
  });

  it("normalizes known project aliases and legacy repo hashes", () => {
    const normalized = normalizeProjectIdentity({
      displayName: "agentic-spec-driven-auto-build",
      repoHash: sha256Hex("repo:agentic-spec-driven-auto-build"),
      remoteHash: null,
      pathHash: "legacy-path-hash-123456"
    });

    expect(normalized).toEqual({
      displayName: "Spec-Driven-Autonomous-Coding-System",
      repoHash: sha256Hex("repo:Spec-Driven-Autonomous-Coding-System"),
      remoteHash: "",
      pathHash: sha256Hex("repo:Spec-Driven-Autonomous-Coding-System")
    });
  });

  it("uses remote hashes as the git-backed project identity path", () => {
    const normalized = normalizeProjectIdentity({
      displayName: "Spec-Driven-Autonomous-Coding-System",
      repoHash: sha256Hex("repo:Spec-Driven-Autonomous-Coding-System"),
      remoteHash: "remote-hash-1234567890",
      pathHash: "local-path-hash-123456"
    });

    expect(normalized.pathHash).toBe("remote-hash-1234567890");
  });

  it("normalizes can and anz execution sandboxes to skill2studio-next", () => {
    expect(
      normalizeProjectIdentity({
        displayName: "can",
        repoHash: sha256Hex("repo:can"),
        remoteHash: null,
        pathHash: "can-path-hash"
      })
    ).toEqual({
      displayName: "skill2studio-next",
      repoHash: sha256Hex("repo:skill2studio-next"),
      remoteHash: "",
      pathHash: sha256Hex("repo:skill2studio-next")
    });

    expect(
      normalizeProjectIdentity({
        displayName: "anz",
        repoHash: sha256Hex("repo:anz"),
        remoteHash: null,
        pathHash: "anz-path-hash"
      }).displayName
    ).toBe("skill2studio-next");
  });
});

describe("ingestValidatedBatch", () => {
  it("enriches a duplicate fallback event with a recovered real task ID", async () => {
    const enriched: Array<{ sourceEventId: string; taskId: string }> = [];
    const store: IngestStore = {
      requireDevice: async () => ({ id: "device-1" }),
      updateDevice: async () => undefined,
      resolveTool: async () => ({ id: "tool-1" }),
      resolveModelPrice: async () => null,
      upsertProject: async () => ({ id: "project-1" }),
      insertUsageEvent: async () => false,
      enrichUsageEventTask: async (event) => {
        enriched.push({ sourceEventId: event.sourceEventId, taskId: event.taskId });
      },
      incrementDailyRollup: async () => undefined
    };

    const result = await ingestValidatedBatch({
      tokenHash: "token-hash",
      batch: {
        ...validBatch,
        events: [{ ...validBatch.events[0], taskId: "task-real" }]
      },
      store
    });

    expect(result).toEqual({ inserted: 0, duplicates: 1, rejected: [] });
    expect(enriched).toEqual([{ sourceEventId: "event-id-123456", taskId: "task-real" }]);
  });

  it("counts inserted and duplicate events while only rolling up newly inserted events", async () => {
    const projects: Array<{ repoHash: string; remoteHash: string; pathHash: string }> = [];
    const rollups: string[] = [];
    const taskIds: string[] = [];
    const store: IngestStore = {
      requireDevice: async () => ({ id: "device-1" }),
      updateDevice: async () => undefined,
      resolveTool: async () => ({ id: "tool-1" }),
      resolveModelPrice: async () => null,
      upsertProject: async (project) => {
        projects.push(project);
        return { id: "project-1" };
      },
      insertUsageEvent: async (event) => {
        taskIds.push(event.taskId);
        return event.sourceEventId !== "duplicate-event";
      },
      enrichUsageEventTask: async () => undefined,
      incrementDailyRollup: async (event) => {
        rollups.push(event.sourceEventId);
      }
    };

    const result = await ingestValidatedBatch({
      tokenHash: "token-hash",
      batch: {
        ...validBatch,
        events: [
          validBatch.events[0],
          {
            ...validBatch.events[0],
            sourceEventId: "duplicate-event"
          }
        ]
      },
      store
    });

    expect(result).toEqual({ inserted: 1, duplicates: 1, rejected: [] });
    expect(projects).toEqual([
      { displayName: "codex-usage-dashboard", repoHash: "", remoteHash: "", pathHash: "path-hash-123456" },
      { displayName: "codex-usage-dashboard", repoHash: "", remoteHash: "", pathHash: "path-hash-123456" }
    ]);
    expect(rollups).toEqual(["event-id-123456"]);
    expect(taskIds).toEqual(["fallback:device-1", "fallback:device-1"]);
  });

  it("uses server-side model pricing instead of uploaded cost values", async () => {
    const insertedCosts: Array<number | null> = [];
    const rollupCosts: Array<number | null> = [];
    const store: IngestStore = {
      requireDevice: async () => ({ id: "device-1" }),
      updateDevice: async () => undefined,
      resolveTool: async () => ({ id: "tool-1" }),
      resolveModelPrice: async () => ({
        inputCostPerMillionUsd: 2,
        outputCostPerMillionUsd: 10,
        cacheReadCostPerMillionUsd: 0.5,
        cacheWriteCostPerMillionUsd: 1
      }),
      upsertProject: async () => ({ id: "project-1" }),
      insertUsageEvent: async (event) => {
        insertedCosts.push(event.costUsd);
        return true;
      },
      enrichUsageEventTask: async () => undefined,
      incrementDailyRollup: async (event) => {
        rollupCosts.push(event.costUsd);
      }
    };

    const result = await ingestValidatedBatch({
      tokenHash: "token-hash",
      batch: {
        ...validBatch,
        events: [
          {
            ...validBatch.events[0],
            inputTokens: 1_000_000,
            outputTokens: 500_000,
            cacheReadTokens: 250_000,
            cacheWriteTokens: 125_000,
            totalTokens: 1_875_000,
            costUsd: 999
          }
        ]
      },
      store
    });

    expect(result.inserted).toBe(1);
    expect(insertedCosts).toEqual([7.25]);
    expect(rollupCosts).toEqual([7.25]);
  });

  it("resolves model pricing by model name only", async () => {
    const priceLookupArgs: string[][] = [];
    const insertedCosts: Array<number | null> = [];
    const store: IngestStore = {
      requireDevice: async () => ({ id: "device-1" }),
      updateDevice: async () => undefined,
      resolveTool: async () => ({ id: "new-codex-tool-id" }),
      resolveModelPrice: async (...args: string[]) => {
        priceLookupArgs.push(args);
        return {
          inputCostPerMillionUsd: 2.5,
          outputCostPerMillionUsd: 15,
          cacheReadCostPerMillionUsd: 0.25,
          cacheWriteCostPerMillionUsd: 3.125
        };
      },
      upsertProject: async () => ({ id: "project-1" }),
      insertUsageEvent: async (event) => {
        insertedCosts.push(event.costUsd);
        return true;
      },
      enrichUsageEventTask: async () => undefined,
      incrementDailyRollup: async () => undefined
    };

    await ingestValidatedBatch({
      tokenHash: "token-hash",
      batch: {
        ...validBatch,
        events: [
          {
            ...validBatch.events[0],
            model: "gpt-5.6-terra",
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            cacheReadTokens: 1_000_000,
            cacheWriteTokens: 1_000_000,
            totalTokens: 4_000_000
          }
        ]
      },
      store
    });

    expect(priceLookupArgs).toEqual([["gpt-5.6-terra"]]);
    expect(insertedCosts).toEqual([20.875]);
  });
});
