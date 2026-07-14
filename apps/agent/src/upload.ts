import type { IngestBatch } from "@codex-usage-dashboard/shared";
import { validateAcknowledgement, type ValidatedAcknowledgement } from "./acknowledgement.js";

export type UploadResult = {
  ok: boolean;
  status: number;
  body: unknown;
  acknowledgement?: ValidatedAcknowledgement;
};

export async function uploadIngestBatch(input: {
  serverUrl: string;
  deviceToken: string;
  batch: IngestBatch;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<UploadResult> {
  const fetchClient = input.fetchImpl ?? fetch;
  const response = await fetchClient(new URL("/api/ingest/events", input.serverUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.deviceToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(input.batch),
    signal: input.signal
  });

  const text = await response.text();
  const body = parseResponseBody(text);

  const result: UploadResult = {
    ok: response.ok,
    status: response.status,
    body
  };
  if (response.ok) result.acknowledgement = validateAcknowledgement(input.batch.events, body);
  return result;
}

function parseResponseBody(text: string): unknown {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}
