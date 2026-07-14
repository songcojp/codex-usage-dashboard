import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { DeviceAuthError } from "../devices/service.js";
import type { IngestResult } from "./service.js";

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
});
