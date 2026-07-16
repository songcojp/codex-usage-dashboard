import type { FastifyInstance } from "fastify";
import {
  taskMetadataBatchEnvelopeSchema,
  taskRebuildRequestSchema,
  type TaskRebuildRequest
} from "@codex-usage-dashboard/shared";
import { DeviceAuthError } from "../devices/service.js";
import { hashBearerTokenCandidates } from "./auth.js";
import {
  ingestBatch,
  IngestValidationError,
  summarizeIngestResult,
  validateBatch,
  type IngestResult
} from "./service.js";
import {
  ingestTaskMetadata,
  type TaskMetadataIngestResult
} from "./task-metadata.js";
import {
  rebuildTaskUsage,
  type TaskRebuildResult
} from "./task-rebuild.js";

export type IngestEventsHandler = (input: { tokenHash: string; batch: unknown }) => Promise<IngestResult>;
export type IngestTasksHandler = (input: { tokenHash: string; batch: unknown }) => Promise<TaskMetadataIngestResult>;
export type RebuildTaskHandler = (input: {
  tokenHash: string;
  request: TaskRebuildRequest;
}) => Promise<TaskRebuildResult>;

export type RegisterIngestRoutesOptions = {
  ingestEvents?: IngestEventsHandler;
  ingestTasks?: IngestTasksHandler;
  rebuildTask?: RebuildTaskHandler;
};

export async function registerIngestRoutes(
  app: FastifyInstance,
  options: RegisterIngestRoutesOptions = {}
): Promise<void> {
  const ingestEvents = options.ingestEvents ?? ingestBatch;
  const ingestTasks = options.ingestTasks ?? ingestTaskMetadata;
  const rebuildTask = options.rebuildTask ?? rebuildTaskUsage;

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

  app.post("/api/ingest/tasks", async (request, reply) => {
    let tokenHashes: [string, string];
    try {
      tokenHashes = hashBearerTokenCandidates(request.headers.authorization);
    } catch {
      return reply.code(401).send({ error: "missing bearer token" });
    }

    const parsed = taskMetadataBatchEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid task metadata batch" });
    }

    request.log.info({ taskCount: parsed.data.tasks.length }, "validated task metadata batch");
    for (const [index, tokenHash] of tokenHashes.entries()) {
      try {
        return await ingestTasks({ tokenHash, batch: parsed.data });
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

  app.post("/api/ingest/rebuild-task", async (request, reply) => {
    let tokenHashes: [string, string];
    try {
      tokenHashes = hashBearerTokenCandidates(request.headers.authorization);
    } catch {
      return reply.code(401).send({ error: "missing bearer token" });
    }

    const parsed = taskRebuildRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid task rebuild request" });
    }

    request.log.warn({
      taskId: parsed.data.taskId,
      canonicalEvents: parsed.data.sourceEventIds.length
    }, "validated targeted task rebuild");
    for (const [index, tokenHash] of tokenHashes.entries()) {
      try {
        return await rebuildTask({ tokenHash, request: parsed.data });
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
