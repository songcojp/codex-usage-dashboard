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
        taskId: `fallback:${device.id}`,
        model: null,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 20,
        costUsd: "0.1234",
        rawMetaJson: {}
      });
      await db.insert(usageEvents).values({
        occurredAt: new Date("2026-05-29T12:00:00.000Z"),
        toolId: tool.id,
        deviceId: device.id,
        projectId: project.id,
        sourceEventId: `earlier-event-${unique}`,
        taskId: `fallback:${device.id}`,
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
      const projectRatios = await service.getProjectRatios(filters);
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
      expect(projectRatios).toEqual({
        daily: [
          {
            day: "2026-05-30",
            projects: [
              {
                projectKey: `repo:${project.repoHash}`,
                projectName: project.displayName,
                totalTokens: 20
              }
            ]
          }
        ],
        total: [
          {
            projectKey: `repo:${project.repoHash}`,
            projectName: project.displayName,
            totalTokens: 40
          }
        ]
      });
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

  testWithDatabase("groups filtered usage by task before sorting and pagination", async () => {
    if (!db) {
      throw new Error("TEST_DATABASE_URL was set but database was not initialized");
    }

    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const service = createAdminQueryService(db);
    const [deviceA, deviceB] = await db
      .insert(devices)
      .values([
        {
          name: `Device A ${unique}`,
          os: "linux",
          hostnameHash: `host-a-${unique}`,
          deviceTokenHash: hashToken(`device-a-${unique}`)
        },
        {
          name: `Device B ${unique}`,
          os: "linux",
          hostnameHash: `host-b-${unique}`,
          deviceTokenHash: hashToken(`device-b-${unique}`)
        }
      ])
      .returning();
    const [tool] = await db
      .insert(tools)
      .values({ slug: `task-tool-${unique}`, displayName: `Task Tool ${unique}` })
      .returning();
    const [projectA, projectB] = await db
      .insert(projects)
      .values([
        {
          displayName: `Project A ${unique}`,
          repoHash: `repo-a-${unique}`,
          remoteHash: "",
          pathHash: `path-a-${unique}`
        },
        {
          displayName: `Project B ${unique}`,
          repoHash: `repo-b-${unique}`,
          remoteHash: "",
          pathHash: `path-b-${unique}`
        }
      ])
      .returning();

    await db.insert(usageEvents).values([
      {
        occurredAt: new Date("2026-07-15T10:00:00.000Z"),
        toolId: tool.id,
        deviceId: deviceA.id,
        projectId: projectA.id,
        sourceEventId: `alpha-1-${unique}`,
        taskId: `task-alpha-${unique}`,
        model: "gpt-5",
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
        totalTokens: 16,
        costUsd: "0.10",
        rawMetaJson: {}
      },
      {
        occurredAt: new Date("2026-07-15T11:00:00.000Z"),
        toolId: tool.id,
        deviceId: deviceB.id,
        projectId: projectB.id,
        sourceEventId: `alpha-2-${unique}`,
        taskId: `task-alpha-${unique}`,
        model: "gpt-5",
        inputTokens: 20,
        outputTokens: 4,
        cacheReadTokens: 6,
        cacheWriteTokens: 2,
        totalTokens: 32,
        costUsd: "0.20",
        rawMetaJson: {}
      },
      {
        occurredAt: new Date("2026-07-15T12:00:00.000Z"),
        toolId: tool.id,
        deviceId: deviceA.id,
        projectId: projectA.id,
        sourceEventId: `fallback-${unique}`,
        taskId: `fallback:${deviceA.id}`,
        model: "gpt-5",
        inputTokens: 5,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 6,
        costUsd: "0.05",
        rawMetaJson: {}
      },
      {
        occurredAt: new Date("2026-07-15T09:00:00.000Z"),
        toolId: tool.id,
        deviceId: deviceA.id,
        projectId: projectA.id,
        sourceEventId: `tie-a-${unique}`,
        taskId: `task-a-tie-${unique}`,
        model: "tie-model",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 2,
        costUsd: "0.01",
        rawMetaJson: {}
      },
      {
        occurredAt: new Date("2026-07-15T09:00:00.000Z"),
        toolId: tool.id,
        deviceId: deviceA.id,
        projectId: projectA.id,
        sourceEventId: `tie-b-${unique}`,
        taskId: `task-b-tie-${unique}`,
        model: "tie-model",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 2,
        costUsd: "0.01",
        rawMetaJson: {}
      }
    ]);

    const result = await service.getTasks({
      from: "2026-07-15",
      to: "2026-07-15",
      timeZone: "UTC",
      tool: tool.slug,
      model: "gpt-5",
      sortBy: "totalTokens",
      sortDir: "desc",
      limit: 1,
      offset: 0
    });

    expect(result.total).toBe(2);
    expect(result.rows).toEqual([
      expect.objectContaining({
        taskId: `task-alpha-${unique}`,
        isFallback: false,
        startedAt: new Date("2026-07-15T10:00:00.000Z"),
        lastActivityAt: new Date("2026-07-15T11:00:00.000Z"),
        deviceId: null,
        deviceName: null,
        deviceCount: 2,
        projectId: null,
        projectName: null,
        projectCount: 2,
        eventCount: 2,
        inputTokens: 30,
        outputTokens: 6,
        cacheReadTokens: 9,
        cacheWriteTokens: 3,
        totalTokens: 48,
        costUsd: 0.3
      })
    ]);

    const fallback = await service.getTasks({
      from: "2026-07-15",
      to: "2026-07-15",
      timeZone: "UTC",
      tool: tool.slug,
      deviceId: deviceA.id,
      model: "gpt-5",
      sortBy: "lastActivityAt",
      sortDir: "desc"
    });
    expect(fallback.rows[0]).toMatchObject({
      taskId: `fallback:${deviceA.id}`,
      isFallback: true,
      deviceId: deviceA.id,
      deviceName: `Device A ${unique}`,
      deviceCount: 1,
      projectId: projectA.id,
      projectName: `Project A ${unique}`,
      projectCount: 1
    });

    const filtered = await service.getTasks({
      from: "2026-07-15",
      to: "2026-07-15",
      timeZone: "UTC",
      tool: tool.slug,
      deviceId: deviceA.id,
      projectId: projectA.id,
      model: "gpt-5"
    });
    expect(filtered.rows.find((row) => row.taskId === `task-alpha-${unique}`)).toMatchObject({
      eventCount: 1,
      totalTokens: 16
    });

    for (const [sortBy, sortDir, firstTask] of [
      ["lastActivityAt", "desc", `fallback:${deviceA.id}`],
      ["lastActivityAt", "asc", `task-alpha-${unique}`],
      ["eventCount", "desc", `task-alpha-${unique}`],
      ["eventCount", "asc", `fallback:${deviceA.id}`],
      ["totalTokens", "desc", `task-alpha-${unique}`],
      ["totalTokens", "asc", `fallback:${deviceA.id}`],
      ["costUsd", "desc", `task-alpha-${unique}`],
      ["costUsd", "asc", `fallback:${deviceA.id}`]
    ] as const) {
      const sorted = await service.getTasks({
        from: "2026-07-15",
        to: "2026-07-15",
        timeZone: "UTC",
        tool: tool.slug,
        model: "gpt-5",
        sortBy,
        sortDir
      });
      expect(sorted.rows[0]?.taskId).toBe(firstTask);
    }

    const ties = await service.getTasks({
      from: "2026-07-15",
      to: "2026-07-15",
      timeZone: "UTC",
      tool: tool.slug,
      model: "tie-model",
      sortBy: "totalTokens",
      sortDir: "desc"
    });
    expect(ties.rows.map((row) => row.taskId)).toEqual([
      `task-a-tie-${unique}`,
      `task-b-tie-${unique}`
    ]);
  });
});
