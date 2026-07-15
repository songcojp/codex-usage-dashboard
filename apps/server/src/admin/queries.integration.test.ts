import { hashToken } from "@codex-usage-dashboard/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type TokenReportDb } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { dailyUsageRollups, devices, projects, tools, usageEvents } from "../db/schema.js";
import { createAdminQueryService } from "./queries.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testWithDatabase = testDatabaseUrl ? it : it.skip;

describe("admin query service Postgres persistence", () => {
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
    "returns real admin rows and stores only hashed device tokens (requires TEST_DATABASE_URL)",
    async () => {
      if (!db) {
        throw new Error("TEST_DATABASE_URL was set but database was not initialized");
      }

      const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const token = `plain-token-${unique}`;
      const tokenHash = hashToken(token);
      const service = createAdminQueryService(db);
      const [device] = await db
        .insert(devices)
        .values({
          name: `Device ${unique}`,
          os: "linux",
          hostnameHash: `host-${unique}`,
          deviceTokenHash: tokenHash
        })
        .returning();
      const [tool] = await db
        .insert(tools)
        .values({
          slug: `tool-${unique}`,
          displayName: `Tool ${unique}`
        })
        .returning();
      const [project] = await db
        .insert(projects)
        .values({
          displayName: `Project ${unique}`,
          repoHash: `repo-${unique}`,
          remoteHash: `remote-${unique}`,
          pathHash: `path-${unique}`
        })
        .returning();

      await db.insert(usageEvents).values({
        occurredAt: new Date("2026-05-30T12:00:00.000Z"),
        toolId: tool.id,
        deviceId: device.id,
        projectId: project.id,
        sourceEventId: `event-${unique}`,
        model: null,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 20,
        costUsd: "0.1234",
        rawMetaJson: {}
      });
      await db.insert(dailyUsageRollups).values({
        day: "2026-05-30",
        toolId: tool.id,
        deviceId: device.id,
        projectId: project.id,
        model: "unknown",
        eventCount: 1,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 20,
        costUsd: "0.1234"
      });

      const filters = {
        from: "2026-05-30",
        to: "2026-05-30",
        tool: tool.slug,
        deviceId: device.id,
        projectId: project.id,
        model: "unknown"
      };
      const summary = await service.getSummary(filters);
      const trends = await service.getTrends(filters);
      const events = await service.getEvents(filters);
      const sortedEvents = await service.getEvents({
        ...filters,
        sortBy: "totalTokens",
        sortDir: "asc"
      });
      const deviceRows = await service.listDevices(filters);
      const projectRows = await service.listProjects(filters);
      const modelRows = await service.listModels({
        from: filters.from,
        to: filters.to,
        tool: filters.tool,
        deviceId: filters.deviceId,
        projectId: filters.projectId
      });
      const toolRows = await service.listTools();
      const created = await service.createDevice({
        name: `Created ${unique}`,
        os: "linux",
        hostnameHash: `created-host-${unique}`,
        token: `created-token-${unique}`
      });

      const [createdDevice] = await db
        .select()
        .from(devices)
        .where(eq(devices.id, created.id as string));

      expect(summary).toEqual({
        totalTokens: 20,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        costUsd: 0.1234,
        eventCount: 1
      });
      expect(trends.points).toEqual([
        {
          day: "2026-05-30",
          totalTokens: 20,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          costUsd: 0.1234,
          inputCostUsd: 0,
          outputCostUsd: 0,
          cacheCostUsd: 0,
          toolUsages: [
            {
              toolSlug: tool.slug,
              toolName: tool.displayName,
              totalTokens: 20,
              costUsd: 0.1234
            }
          ]
        }
      ]);
      expect(events.total).toBe(1);
      expect(events.rows[0]).toMatchObject({
        tool: tool.slug,
        deviceId: device.id,
        projectId: project.id,
        model: "unknown",
        totalTokens: 20,
        costUsd: 0.1234
      });
      expect(sortedEvents.rows[0]).toMatchObject({
        tool: tool.slug,
        totalTokens: 20,
        costUsd: 0.1234
      });
      expect(deviceRows.rows).toContainEqual(
        expect.objectContaining({
          id: device.id,
          name: `Device ${unique}`,
          totalTokens: 20,
          costUsd: 0.1234,
          eventCount: 1
        })
      );
      expect(JSON.stringify(deviceRows.rows)).not.toContain(tokenHash);
      expect(projectRows.rows).toContainEqual(
        expect.objectContaining({
          id: project.id,
          displayName: `Project ${unique}`,
          totalTokens: 20,
          costUsd: 0.1234,
          eventCount: 1
        })
      );
      expect(modelRows.rows).toContainEqual({ model: "unknown" });
      expect(toolRows.rows).toContainEqual(
        expect.objectContaining({
          id: tool.id,
          slug: tool.slug
        })
      );
      expect(created).toMatchObject({
        name: `Created ${unique}`,
        token: `created-token-${unique}`
      });
      expect(created).not.toHaveProperty("deviceTokenHash");
      expect(createdDevice.deviceTokenHash).toBe(hashToken(`created-token-${unique}`));
    }
  );
});
