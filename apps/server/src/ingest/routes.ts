import type { FastifyInstance } from "fastify";
import { DeviceAuthError } from "../devices/service.js";
import { hashBearerTokenCandidates } from "./auth.js";
import {
  ingestBatch,
  IngestValidationError,
  summarizeIngestResult,
  validateBatch,
  type IngestResult
} from "./service.js";

export type IngestEventsHandler = (input: { tokenHash: string; batch: unknown }) => Promise<IngestResult>;

export type RegisterIngestRoutesOptions = {
  ingestEvents?: IngestEventsHandler;
};

export async function registerIngestRoutes(
  app: FastifyInstance,
  options: RegisterIngestRoutesOptions = {}
): Promise<void> {
  const ingestEvents = options.ingestEvents ?? ingestBatch;

  app.post("/api/ingest/events", async (request, reply) => {
    let tokenHashes: [string, string];

    try {
      tokenHashes = hashBearerTokenCandidates(request.headers.authorization);
    } catch {
      return reply.code(401).send({ error: "missing bearer token" });
    }

    let batch;
    try {
      batch = validateBatch(request.body);
    } catch (error) {
      if (error instanceof IngestValidationError) {
        return reply.code(400).send({ error: "invalid ingest batch" });
      }

      throw error;
    }

    request.log.info({ eventCount: batch.events.length }, "validated ingest batch");

    for (const [index, tokenHash] of tokenHashes.entries()) {
      try {
        return summarizeIngestResult(await ingestEvents({ tokenHash, batch }));
      } catch (error) {
        if (error instanceof DeviceAuthError && index < tokenHashes.length - 1) continue;
        if (error instanceof DeviceAuthError) {
          return reply.code(401).send({ error: "invalid device token" });
        }

        throw error;
      }
    }

    return reply.code(401).send({ error: "invalid device token" });
  });
}
