import type { IngestBatch } from "@codex-usage-dashboard/shared";
import { describe, expect, it } from "vitest";
import { uploadIngestBatch } from "./upload.js";

function batch(): IngestBatch {
  return {
    device: {
      name: "workstation",
      os: "linux",
      hostnameHash: "a".repeat(64)
    },
    events: []
  };
}

describe("uploadIngestBatch", () => {
  it("posts an ingest batch with bearer token auth", async () => {
    const ingestBatch = batch();
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetchImpl = async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: url as URL, init: init ?? {} });
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    };

    const result = await uploadIngestBatch({
      serverUrl: "https://example.test",
      deviceToken: "device-token",
      batch: ingestBatch,
      fetchImpl
    });

    expect(result).toEqual({ ok: true, status: 202, body: { accepted: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.toString()).toBe("https://example.test/api/ingest/events");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({
      authorization: "Bearer device-token",
      "content-type": "application/json"
    });
    expect(calls[0]?.init.body).toBe(JSON.stringify(ingestBatch));
  });

  it("preserves non-JSON response text without throwing", async () => {
    const fetchImpl = async () => new Response("service unavailable", { status: 503 });

    await expect(
      uploadIngestBatch({
        serverUrl: "https://example.test",
        deviceToken: "device-token",
        batch: batch(),
        fetchImpl
      })
    ).resolves.toEqual({
      ok: false,
      status: 503,
      body: { text: "service unavailable" }
    });
  });
});
