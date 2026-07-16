import type { TaskRebuildRequest } from "@codex-usage-dashboard/shared";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { createDb, type TokenReportDb } from "../db/client.js";
import { dailyUsageRollups, usageEvents } from "../db/schema.js";
import { requireDeviceByTokenHash } from "../devices/service.js";

export type TaskRebuildResult = {
  deleted: number;
  canonicalEvents: number;
  rollupsRebuilt: number;
};

export type TaskRebuildStore = {
  requireDevice(tokenHash: string): Promise<{ id: string }>;
  replaceTaskEvents(input: {
    deviceId: string;
    taskId: string;
    canonicalSourceEventIds: string[];
  }): Promise<{ deleted: number; rollupsRebuilt: number }>;
};

export async function rebuildTaskUsage(input: {
  tokenHash: string;
  request: TaskRebuildRequest;
  store?: TaskRebuildStore;
  db?: TokenReportDb;
}): Promise<TaskRebuildResult> {
  const store = input.store ?? createTaskRebuildStore(input.db);
  const device = await store.requireDevice(input.tokenHash);
  const rebuilt = await store.replaceTaskEvents({
    deviceId: device.id,
    taskId: input.request.taskId,
    canonicalSourceEventIds: input.request.sourceEventIds
  });
  return {
    deleted: rebuilt.deleted,
    canonicalEvents: input.request.sourceEventIds.length,
    rollupsRebuilt: rebuilt.rollupsRebuilt
  };
}

function createTaskRebuildStore(existingDb?: TokenReportDb): TaskRebuildStore {
  const owned = existingDb ? null : createDb();
  const db = existingDb ?? owned!.db;
  return {
    requireDevice(tokenHash) {
      return requireDeviceByTokenHash(db, tokenHash);
    },
    replaceTaskEvents(input) {
      return db.transaction(async (tx) => {
        const deleted = await tx
          .delete(usageEvents)
          .where(and(
            eq(usageEvents.deviceId, input.deviceId),
            eq(usageEvents.taskId, input.taskId),
            notInArray(usageEvents.sourceEventId, input.canonicalSourceEventIds)
          ))
          .returning({ id: usageEvents.id });

        await tx.delete(dailyUsageRollups);
        const rebuilt = await tx.execute(sql`
          INSERT INTO ${dailyUsageRollups} (
            day,
            tool_id,
            device_id,
            project_id,
            model,
            event_count,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            total_tokens,
            cost_usd
          )
          SELECT
            (${usageEvents.occurredAt} AT TIME ZONE 'Asia/Tokyo')::date,
            ${usageEvents.toolId},
            ${usageEvents.deviceId},
            ${usageEvents.projectId},
            coalesce(${usageEvents.model}, 'unknown'),
            count(*)::integer,
            sum(${usageEvents.inputTokens}),
            sum(${usageEvents.outputTokens}),
            sum(${usageEvents.cacheReadTokens}),
            sum(${usageEvents.cacheWriteTokens}),
            sum(${usageEvents.totalTokens}),
            sum(coalesce(${usageEvents.costUsd}, 0))
          FROM ${usageEvents}
          GROUP BY
            (${usageEvents.occurredAt} AT TIME ZONE 'Asia/Tokyo')::date,
            ${usageEvents.toolId},
            ${usageEvents.deviceId},
            ${usageEvents.projectId},
            coalesce(${usageEvents.model}, 'unknown')
          RETURNING day
        `);

        return {
          deleted: deleted.length,
          rollupsRebuilt: rebuilt.rowCount ?? rebuilt.rows.length
        };
      });
    }
  };
}
