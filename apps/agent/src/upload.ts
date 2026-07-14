import type { IngestBatch } from "@codex-usage-dashboard/shared";

export type UploadResult = {
  ok: boolean;
  status: number;
  body: unknown;
};

export async function uploadIngestBatch(input: {
  serverUrl: string;
  deviceToken: string;
  batch: IngestBatch;
  fetchImpl?: typeof fetch;
}): Promise<UploadResult> {
  const fetchClient = input.fetchImpl ?? fetch;
  const response = await fetchClient(new URL("/api/ingest/events", input.serverUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.deviceToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(input.batch)
  });

  const text = await response.text();
  const body = parseResponseBody(text);

  return {
    ok: response.ok,
    status: response.status,
    body
  };
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
