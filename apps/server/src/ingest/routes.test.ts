import { describe, expect, it } from "vitest";
import { hashToken } from "@codex-usage-dashboard/shared";
import { buildApp } from "../app.js";
import { DeviceAuthError } from "../devices/service.js";
import type { IngestResult } from "./service.js";
import type { TaskMetadataIngestResult } from "./task-metadata.js";
import type { TaskRebuildResult } from "./task-rebuild.js";

const validPayload = {
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

async function postEvents(
  payload: unknown,
  authorization: string | null = "Bearer device-token",
  ingestEvents = async (): Promise<IngestResult> => ({ inserted: 1, duplicates: 0, rejected: [] })
) {
  const app = await buildApp({ ingestEvents });

  try {
    return await app.inject({
      method: "POST",
      url: "/api/ingest/events",
      headers: authorization === null ? {} : { authorization },
      payload
    });
  } finally {
    await app.close();
  }
}

const validTaskPayload = {
  tasks: [
    {
      taskId: "task-1",
      title: "Named task",
      updatedAt: "2026-07-16T00:00:00.000Z"
    }
  ]
};

async function postTasks(
  payload: unknown,
  authorization: string | null = "Bearer device-token",
  ingestTasks = async (): Promise<TaskMetadataIngestResult> => ({
    inserted: 1,
    updated: 0,
    stale: 0,
    rejected: []
  })
) {
  const app = await buildApp({ ingestTasks });

  try {
    return await app.inject({
      method: "POST",
      url: "/api/ingest/tasks",
      headers: authorization === null ? {} : { authorization },
      payload
    });
  } finally {
    await app.close();
  }
}

async function postTaskRebuild(
  payload: unknown,
  authorization: string | null = "Bearer device-token",
  rebuildTask = async (): Promise<TaskRebuildResult> => ({
    deleted: 10,
    canonicalEvents: 2,
    rollupsRebuilt: 7
  })
) {
  const app = await buildApp({ rebuildTask });

  try {
    return await app.inject({
      method: "POST",
      url: "/api/ingest/rebuild-task",
      headers: authorization === null ? {} : { authorization },
      payload
    });
  } finally {
    await app.close();
  }
}

describe("POST /api/ingest/events", () => {
  it("returns 401 when bearer token is missing", async () => {
    const response = await postEvents(validPayload, null);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "missing bearer token" });
  });

  it("returns 401 when bearer token is empty", async () => {
    const response = await postEvents(validPayload, "Bearer ");

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "missing bearer token" });
  });

  it("returns a client error for malformed bodies", async () => {
    const response = await postEvents({ device: {}, events: "not-events" });

    expect([400, 422]).toContain(response.statusCode);
    expect(response.json()).toEqual({ error: "invalid ingest batch" });
  });

  it("returns a client error for unsafe metadata", async () => {
    const response = await postEvents({
      ...validPayload,
      events: [
        {
          ...validPayload.events[0],
          metadata: {
            prompt: "private content"
          }
        }
      ]
    });

    expect([400, 422]).toContain(response.statusCode);
    expect(response.json()).toEqual({ error: "invalid ingest batch" });
  });

  it("returns a client error for mismatched token totals", async () => {
    const response = await postEvents({
      ...validPayload,
      events: [
        {
          ...validPayload.events[0],
          totalTokens: 19
        }
      ]
    });

    expect([400, 422]).toContain(response.statusCode);
    expect(response.json()).toEqual({ error: "invalid ingest batch" });
  });

  it("returns the persisted ingest result for valid payloads", async () => {
    const response = await postEvents(validPayload);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ inserted: 1, duplicates: 0, rejected: [] });
  });

  it("returns 401 when the device token is not accepted by the ingest service", async () => {
    const response = await postEvents(validPayload, "Bearer bad-token", async () => {
      throw new DeviceAuthError();
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid device token" });
  });

  it("falls back to the legacy token hash for migrated devices", async () => {
    const attemptedHashes: string[] = [];
    const response = await postEvents(validPayload, "Bearer device-token", async ({ tokenHash }) => {
      attemptedHashes.push(tokenHash);
      if (attemptedHashes.length === 1) throw new DeviceAuthError();
      return { inserted: 1, duplicates: 0, rejected: [] };
    });

    expect(response.statusCode).toBe(200);
    expect(attemptedHashes).toEqual([
      hashToken("device-token"),
      "3e6ac30708331620d70972bdba4e6f0ac619e7848bf21f48257cbc828491ce82"
    ]);
  });
});

describe("POST /api/ingest/tasks", () => {
  it("returns 401 when bearer token is missing", async () => {
    const response = await postTasks(validTaskPayload, null);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "missing bearer token" });
  });

  it("rejects envelopes above 1000 records", async () => {
    const response = await postTasks({ tasks: Array.from({ length: 1001 }, () => ({})) });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid task metadata batch" });
  });

  it("returns the task metadata ingest result", async () => {
    const response = await postTasks(validTaskPayload);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ inserted: 1, updated: 0, stale: 0, rejected: [] });
  });

  it("returns 401 when the device token is not accepted", async () => {
    const response = await postTasks(validTaskPayload, "Bearer bad-token", async () => {
      throw new DeviceAuthError();
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid device token" });
  });

  it("falls back to the legacy token hash", async () => {
    const attemptedHashes: string[] = [];
    const response = await postTasks(validTaskPayload, "Bearer device-token", async ({ tokenHash }) => {
      attemptedHashes.push(tokenHash);
      if (attemptedHashes.length === 1) throw new DeviceAuthError();
      return { inserted: 1, updated: 0, stale: 0, rejected: [] };
    });

    expect(response.statusCode).toBe(200);
    expect(attemptedHashes).toEqual([
      hashToken("device-token"),
      "3e6ac30708331620d70972bdba4e6f0ac619e7848bf21f48257cbc828491ce82"
    ]);
  });
});

describe("POST /api/ingest/rebuild-task", () => {
  const payload = {
    taskId: "task-1",
    sourceEventIds: ["event-123456789", "event-987654321"]
  };

  it("requires a device bearer token", async () => {
    const response = await postTaskRebuild(payload, null);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "missing bearer token" });
  });

  it("rejects malformed canonical event sets", async () => {
    const response = await postTaskRebuild({
      taskId: "task-1",
      sourceEventIds: ["duplicate-event", "duplicate-event"]
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid task rebuild request" });
  });

  it("returns the targeted rebuild result", async () => {
    const response = await postTaskRebuild(payload);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      deleted: 10,
      canonicalEvents: 2,
      rollupsRebuilt: 7
    });
  });

  it("returns 401 when the device token is rejected", async () => {
    const response = await postTaskRebuild(payload, "Bearer bad-token", async () => {
      throw new DeviceAuthError();
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid device token" });
  });
});
