import {
  taskMetadataBatchEnvelopeSchema,
  taskMetadataDraftSchema,
  type TaskMetadataAcknowledgement,
  type TaskMetadataDraft
} from "@codex-usage-dashboard/shared";
import { and, eq, lt } from "drizzle-orm";
import { createDb, type TokenReportDb } from "../db/client.js";
import { taskMetadata } from "../db/schema.js";
import { requireDeviceByTokenHash } from "../devices/service.js";

export type TaskMetadataWriteOutcome = "inserted" | "updated" | "stale";

export type TaskMetadataStore = {
  requireDevice(tokenHash: string): Promise<{ id: string }>;
  writeRevision(deviceId: string, task: TaskMetadataDraft): Promise<TaskMetadataWriteOutcome>;
};

export type TaskMetadataIngestResult = TaskMetadataAcknowledgement;

type TaskMetadataDb = Pick<TokenReportDb, "insert" | "query" | "update">;

let defaultDb: TokenReportDb | undefined;

export async function ingestTaskMetadata(input: {
  tokenHash: string;
  batch: unknown;
  db?: TokenReportDb;
}): Promise<TaskMetadataIngestResult> {
  const envelope = taskMetadataBatchEnvelopeSchema.parse(input.batch);
  const db = input.db ?? getDefaultDb();
  return db.transaction((tx) =>
    ingestValidatedTaskMetadata({
      tokenHash: input.tokenHash,
      rawTasks: envelope.tasks,
      store: createDrizzleTaskMetadataStore(tx)
    })
  );
}

export async function ingestValidatedTaskMetadata(input: {
  tokenHash: string;
  rawTasks: unknown[];
  store: TaskMetadataStore;
}): Promise<TaskMetadataIngestResult> {
  const device = await input.store.requireDevice(input.tokenHash);
  const result: TaskMetadataIngestResult = {
    inserted: 0,
    updated: 0,
    stale: 0,
    rejected: []
  };

  for (const rawTask of input.rawTasks) {
    const parsed = taskMetadataDraftSchema.safeParse(rawTask);
    if (!parsed.success) {
      result.rejected.push({
        taskId: rawTaskId(rawTask),
        reason: "invalid task metadata"
      });
      continue;
    }

    const outcome = await input.store.writeRevision(device.id, parsed.data);
    result[outcome] += 1;
  }

  return result;
}

export function createDrizzleTaskMetadataStore(db: TaskMetadataDb): TaskMetadataStore {
  return {
    requireDevice(tokenHash) {
      return requireDeviceByTokenHash(db, tokenHash);
    },

    async writeRevision(deviceId, task) {
      const sourceUpdatedAt = new Date(task.updatedAt);
      const [inserted] = await db
        .insert(taskMetadata)
        .values({
          taskId: task.taskId,
          title: task.title,
          sourceUpdatedAt,
          deviceId
        })
        .onConflictDoNothing({ target: taskMetadata.taskId })
        .returning({ taskId: taskMetadata.taskId });
      if (inserted) return "inserted";

      const [updated] = await db
        .update(taskMetadata)
        .set({
          title: task.title,
          sourceUpdatedAt,
          deviceId,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(taskMetadata.taskId, task.taskId),
            lt(taskMetadata.sourceUpdatedAt, sourceUpdatedAt)
          )
        )
        .returning({ taskId: taskMetadata.taskId });
      return updated ? "updated" : "stale";
    }
  };
}

function rawTaskId(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const taskId = (value as Record<string, unknown>).taskId;
  return typeof taskId === "string" ? taskId : "";
}

function getDefaultDb(): TokenReportDb {
  defaultDb ??= createDb().db;
  return defaultDb;
}
