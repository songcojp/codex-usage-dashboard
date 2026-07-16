import { hashToken } from "@codex-usage-dashboard/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type TokenReportDb } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { devices, taskMetadata } from "../db/schema.js";
import { ingestTaskMetadata } from "./task-metadata.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testWithDatabase = testDatabaseUrl ? it : it.skip;

describe("task metadata Postgres persistence", () => {
  let pool: ReturnType<typeof createDb>["pool"] | undefined;
  let db: TokenReportDb | undefined;

  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    await migrate(testDatabaseUrl);
    const connection = createDb(testDatabaseUrl);
    pool = connection.pool;
    db = connection.db;
  });

  afterAll(async () => {
    await pool?.end();
  });

  testWithDatabase("accepts only strictly newer title revisions", async () => {
    if (!db) throw new Error("TEST_DATABASE_URL was set but database was not initialized");

    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tokenHash = hashToken(`task-metadata-${unique}`);
    const taskId = `task-${unique}`;
    const [device] = await db.insert(devices).values({
      name: "Task metadata test",
      os: "test",
      hostnameHash: `host-${unique}`,
      deviceTokenHash: tokenHash
    }).returning({ id: devices.id });
    if (!device) throw new Error("failed to create integration device");

    try {
      const send = (title: string, updatedAt: string) => ingestTaskMetadata({
        tokenHash,
        batch: { tasks: [{ taskId, title, updatedAt }] },
        db
      });

      await expect(send("Initial", "2026-07-16T00:00:00.000Z")).resolves.toMatchObject({ inserted: 1 });
      await expect(send("Newest", "2026-07-16T01:00:00.000Z")).resolves.toMatchObject({ updated: 1 });
      await expect(send("Older", "2026-07-16T00:30:00.000Z")).resolves.toMatchObject({ stale: 1 });
      await expect(send("Equal", "2026-07-16T01:00:00.000Z")).resolves.toMatchObject({ stale: 1 });

      const row = await db.query.taskMetadata.findFirst({
        where: eq(taskMetadata.taskId, taskId)
      });
      expect(row).toMatchObject({
        title: "Newest",
        sourceUpdatedAt: new Date("2026-07-16T01:00:00.000Z"),
        deviceId: device.id
      });
    } finally {
      await db.delete(taskMetadata).where(eq(taskMetadata.taskId, taskId));
      await db.delete(devices).where(eq(devices.id, device.id));
    }
  });
});
