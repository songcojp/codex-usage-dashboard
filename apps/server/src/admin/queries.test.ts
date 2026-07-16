import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  createProjectRatioResponse,
  mergeProjectRowsByRepoHash,
  mergeProjectRatioRows,
  normalizeTaskRow,
  reportingDaySql,
  reportingDayUtcRange
} from "./queries.js";

describe("reportingDayUtcRange", () => {
  it("converts a +09:00 reporting day into its UTC query range", () => {
    expect(reportingDayUtcRange("2026-05-31", "Asia/Tokyo")).toEqual({
      start: new Date("2026-05-30T15:00:00.000Z"),
      end: new Date("2026-05-31T14:59:59.999Z")
    });
  });

  it("uses the selected reporting timezone instead of a fixed +09:00 day", () => {
    expect(reportingDayUtcRange("2026-05-31", "UTC")).toEqual({
      start: new Date("2026-05-31T00:00:00.000Z"),
      end: new Date("2026-05-31T23:59:59.999Z")
    });
  });
});

describe("reportingDaySql", () => {
  it("embeds whitelisted timezones as a stable literal for grouped trend queries", () => {
    const expression = reportingDaySql({
      from: "2026-05-18",
      to: "2026-05-31",
      timeZone: "Asia/Tokyo"
    });

    const query = new PgDialect().sqlToQuery(expression);

    expect(query.sql).toContain("AT TIME ZONE 'Asia/Tokyo'");
    expect(query.params).toEqual([]);
  });
});

describe("admin project query helpers", () => {
  it("shapes daily and all-time project ratio aggregates", () => {
    expect(
      createProjectRatioResponse(
        [
          {
            day: "2026-07-15",
            id: "project-a",
            displayName: "Dashboard",
            repoHash: "repo-hash",
            totalTokens: "20"
          }
        ],
        [
          {
            day: "",
            id: "project-a",
            displayName: "Dashboard",
            repoHash: "repo-hash",
            totalTokens: "40"
          }
        ]
      )
    ).toEqual({
      daily: [
        {
          day: "2026-07-15",
          projects: [
            {
              projectKey: "repo:repo-hash",
              projectName: "Dashboard",
              totalTokens: 20
            }
          ]
        }
      ],
      total: [
        {
          projectKey: "repo:repo-hash",
          projectName: "Dashboard",
          totalTokens: 40
        }
      ]
    });
  });

  it("merges project ratio rows by day and repository identity", () => {
    expect(
      mergeProjectRatioRows([
        {
          day: "2026-07-14",
          id: "project-a",
          displayName: "Dashboard",
          repoHash: "repo-hash",
          totalTokens: "20"
        },
        {
          day: "2026-07-14",
          id: "project-b",
          displayName: "Dashboard",
          repoHash: "repo-hash",
          totalTokens: "30"
        },
        {
          day: "2026-07-15",
          id: "project-c",
          displayName: "Standalone",
          repoHash: null,
          totalTokens: "10"
        }
      ])
    ).toEqual([
      {
        day: "2026-07-14",
        projectKey: "repo:repo-hash",
        projectName: "Dashboard",
        totalTokens: 50
      },
      {
        day: "2026-07-15",
        projectKey: "project:project-c",
        projectName: "Standalone",
        totalTokens: 10
      }
    ]);
  });

  it("aggregates project totals by repo hash across local paths", () => {
    const rows = mergeProjectRowsByRepoHash([
      {
        id: "project-a",
        displayName: "codex-usage-dashboard",
        repoHash: "repo-hash",
        remoteHash: "remote-a",
        pathHash: "path-a",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-02T00:00:00.000Z"),
        totalTokens: "10",
        costUsd: "0.25",
        eventCount: 1
      },
      {
        id: "project-b",
        displayName: "codex-usage-dashboard",
        repoHash: "repo-hash",
        remoteHash: "remote-b",
        pathHash: "path-b",
        createdAt: new Date("2026-05-03T00:00:00.000Z"),
        updatedAt: new Date("2026-05-04T00:00:00.000Z"),
        totalTokens: "15",
        costUsd: "0.5",
        eventCount: "2"
      }
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "project-a",
      displayName: "codex-usage-dashboard",
      repoHash: "repo-hash",
      remoteHash: "remote-a",
      pathHash: "path-a",
      totalTokens: 25,
      costUsd: 0.75,
      eventCount: 3
    });
    expect(rows[0]?.updatedAt).toEqual(new Date("2026-05-04T00:00:00.000Z"));
  });
});

describe("admin task query helpers", () => {
  it("normalizes aggregate values and identifies fallback tasks", () => {
    expect(
      normalizeTaskRow({
        taskId: "fallback:device-a",
        taskName: null,
        startedAt: new Date("2026-07-15T10:00:00.000Z"),
        lastActivityAt: new Date("2026-07-15T11:00:00.000Z"),
        deviceId: "device-a",
        deviceName: "Device A",
        deviceCount: "1",
        projectId: null,
        projectName: null,
        projectCount: "2",
        eventCount: "3",
        inputTokens: "10",
        outputTokens: "2",
        cacheReadTokens: "3",
        cacheWriteTokens: "1",
        totalTokens: "16",
        costUsd: "0.1"
      })
    ).toEqual({
      taskId: "fallback:device-a",
      taskName: null,
      isFallback: true,
      startedAt: new Date("2026-07-15T10:00:00.000Z"),
      lastActivityAt: new Date("2026-07-15T11:00:00.000Z"),
      deviceId: "device-a",
      deviceName: "Device A",
      deviceCount: 1,
      projectId: null,
      projectName: null,
      projectCount: 2,
      eventCount: 3,
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      totalTokens: 16,
      costUsd: 0.1
    });
  });
});
