import { hashToken } from "@codex-usage-dashboard/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type TokenReportDb } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { dailyUsageRollups, devices, tools, usageEvents } from "../db/schema.js";
import { ingestBatch } from "./service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testWithDatabase = testDatabaseUrl ? it : it.skip;

const batch = {
  device: {
    name: "Integration Workstation",
    os: "linux",
    hostnameHash: "integration-hostname-hash"
  },
  events: [
    {
      sourceEventId: "integration-event-123456",
      toolSlug: "codex-cli",
      occurredAt: "2026-05-30T00:00:00.000Z",
      project: {
        displayName: "codex-usage-dashboard-integration",
        repoHash: null,
        remoteHash: null,
        pathHash: "integration-path-hash"
      },
      model: "gpt-5",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      totalTokens: 20,
      costUsd: null,
      metadata: {
        source: "integration-test"
      }
    }
  ]
};

describe("ingestBatch Postgres persistence", () => {
  let pool: ReturnType<typeof createDb>["pool"] | undefined;
  let db: TokenReportDb | undefined;

  beforeAll(async () => {
    if (!testDatabaseUrl) {
      return;
    }

    await migrate(testDatabaseUrl);
    const connection = createDb(testDatabaseUrl);
    pool = connection.pool;
    db = connection.db;
  });

  afterAll(async () => {
    await pool?.end();
  });

  testWithDatabase(
    "persists events idempotently and does not double daily rollups (requires TEST_DATABASE_URL)",
    async () => {
      if (!db) {
        throw new Error("TEST_DATABASE_URL was set but database was not initialized");
      }

      const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const sourceEventId = `integration-event-${uniqueSuffix}`;
      const pathHash = `integration-path-${uniqueSuffix}`;
      const deviceToken = `integration-token-${uniqueSuffix}`;
      const tokenHash = hashToken(deviceToken);

      await db.insert(devices).values({
        name: "Integration Workstation",
        os: "linux",
        hostnameHash: "integration-hostname-hash",
        deviceTokenHash: tokenHash
      });

      const testBatch = {
        ...batch,
        events: [
          {
            ...batch.events[0],
            sourceEventId,
            project: {
              ...batch.events[0].project,
              pathHash
            }
          }
        ]
      };

      const firstResult = await ingestBatch({ tokenHash, batch: testBatch, db });
      const secondResult = await ingestBatch({
        tokenHash,
        batch: {
          ...testBatch,
          events: [{ ...testBatch.events[0], taskId: "recovered-task" }]
        },
        db
      });
      await ingestBatch({
        tokenHash,
        batch: {
          ...testBatch,
          events: [{
            ...testBatch.events[0],
            taskId: "parent-task",
            sourceSessionId: "recovered-task"
          }]
        },
        db
      });
      await ingestBatch({
        tokenHash,
        batch: {
          ...testBatch,
          events: [{
            ...testBatch.events[0],
            taskId: "different-real-task",
            sourceSessionId: "different-child-session"
          }]
        },
        db
      });

      const [tool] = await db.select({ id: tools.id }).from(tools).where(eq(tools.slug, "codex-cli"));
      const [device] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.deviceTokenHash, tokenHash));

      const eventRows = await db
        .select({ id: usageEvents.id, taskId: usageEvents.taskId })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.deviceId, device.id),
            eq(usageEvents.toolId, tool.id),
            eq(usageEvents.sourceEventId, sourceEventId)
          )
        );

      const rollupRows = await db
        .select({
          eventCount: dailyUsageRollups.eventCount,
          totalTokens: dailyUsageRollups.totalTokens
        })
        .from(dailyUsageRollups)
        .where(
          and(
            eq(dailyUsageRollups.day, "2026-05-30"),
            eq(dailyUsageRollups.deviceId, device.id),
            eq(dailyUsageRollups.toolId, tool.id),
            eq(dailyUsageRollups.model, "gpt-5")
          )
        );

      expect(firstResult).toEqual({ inserted: 1, duplicates: 0, rejected: [] });
      expect(secondResult).toEqual({ inserted: 0, duplicates: 1, rejected: [] });
      expect(eventRows).toMatchObject([{ taskId: "parent-task" }]);
      expect(rollupRows).toEqual([{ eventCount: 1, totalTokens: 20 }]);
    }
  );
});
