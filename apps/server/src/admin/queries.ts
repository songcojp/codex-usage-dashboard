import { generateToken, hashToken } from "@codex-usage-dashboard/shared";
import { and, asc, count, desc, eq, gte, lte, or, sql, sum } from "drizzle-orm";
import { createDb, type TokenReportDb } from "../db/client.js";
import { devices, modelPrices, projects, tools, usageEvents } from "../db/schema.js";
import {
  defaultReportingTimeZone,
  reportingDayUtcRange,
  type ReportingTimeZone
} from "../reporting-time.js";

export { reportingDayUtcRange } from "../reporting-time.js";

export type UsageFilters = {
  from: string;
  to: string;
  timeZone?: ReportingTimeZone;
  tool?: string;
  deviceId?: string;
  projectId?: string;
  model?: string;
};

export type EventSortBy =
  | "occurredAt"
  | "totalTokens"
  | "inputTokens"
  | "outputTokens"
  | "cacheTokens"
  | "costUsd";
export type ProjectSortBy = "eventCount" | "totalTokens" | "costUsd" | "updatedAt";
export type SortDir = "asc" | "desc";

export type UsageSummary = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  eventCount: number;
};

export type ProjectRatioItem = {
  projectKey: string;
  projectName: string;
  totalTokens: number;
};

export type ProjectRatioResponse = {
  daily: Array<{ day: string; projects: ProjectRatioItem[] }>;
  total: ProjectRatioItem[];
};

export type ModelPriceInput = {
  model: string;
  inputCostPerMillionUsd: number;
  outputCostPerMillionUsd: number;
  cacheReadCostPerMillionUsd: number;
  cacheWriteCostPerMillionUsd: number;
};

export type AdminQueryService = {
  getSummary(filters: UsageFilters): Promise<UsageSummary>;
  getTrends(filters: UsageFilters): Promise<{ points: Array<Record<string, unknown>> }>;
  getProjectRatios(filters: UsageFilters): Promise<ProjectRatioResponse>;
  getEvents(
    filters: UsageFilters & { limit?: number; offset?: number; sortBy?: EventSortBy; sortDir?: SortDir }
  ): Promise<{
    rows: Array<Record<string, unknown>>;
    total: number;
  }>;
  listDevices(filters?: UsageFilters): Promise<{ rows: Array<Record<string, unknown>> }>;
  createDevice(input: {
    name: string;
    os: string;
    hostnameHash: string;
    token: string;
  }): Promise<Record<string, unknown>>;
  disableDevice(id: string): Promise<Record<string, unknown> | null>;
  listProjects(
    filters?: Partial<UsageFilters> & { sortBy?: ProjectSortBy; sortDir?: SortDir }
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
  listModels(filters: UsageFilters): Promise<{ rows: Array<{ model: string }> }>;
  listTools(): Promise<{ rows: Array<Record<string, unknown>> }>;
  listModelPrices(): Promise<{ rows: Array<Record<string, unknown>> }>;
  upsertModelPrice(input: ModelPriceInput): Promise<Record<string, unknown>>;
  deleteModelPrice(id: string): Promise<Record<string, unknown> | null>;
};

type AdminDb = Pick<TokenReportDb, "delete" | "insert" | "select" | "update">;

type ProjectUsageRow = {
  id: string;
  displayName: string;
  repoHash: string;
  remoteHash: string;
  pathHash: string;
  createdAt: Date;
  updatedAt: Date;
  totalTokens: string | number | null | undefined;
  costUsd: string | number | null | undefined;
  eventCount: string | number | null | undefined;
};

type ProjectRatioRow = {
  day: string;
  id: string;
  displayName: string;
  repoHash: string | null;
  totalTokens: string | number | null | undefined;
};

let defaultDb: TokenReportDb | undefined;

export function generateDeviceToken(): string {
  return generateToken("trd");
}

export function createAdminQueryService(db?: AdminDb): AdminQueryService {
  const adminDb = () => db ?? getDefaultDb();

  return {
    async getSummary(filters) {
      const [row] = await adminDb()
        .select({
          totalTokens: sum(usageEvents.totalTokens),
          inputTokens: sum(usageEvents.inputTokens),
          outputTokens: sum(usageEvents.outputTokens),
          cacheReadTokens: sum(usageEvents.cacheReadTokens),
          cacheWriteTokens: sum(usageEvents.cacheWriteTokens),
          costUsd: sum(usageEvents.costUsd),
          eventCount: count()
        })
        .from(usageEvents)
        .innerJoin(tools, eq(usageEvents.toolId, tools.id))
        .where(eventWhere(filters));

      return {
        totalTokens: numberFromAggregate(row?.totalTokens),
        inputTokens: numberFromAggregate(row?.inputTokens),
        outputTokens: numberFromAggregate(row?.outputTokens),
        cacheReadTokens: numberFromAggregate(row?.cacheReadTokens),
        cacheWriteTokens: numberFromAggregate(row?.cacheWriteTokens),
        costUsd: numberFromAggregate(row?.costUsd),
        eventCount: numberFromAggregate(row?.eventCount)
      };
    },

    async getTrends(filters) {
      const day = reportingDaySql(filters);
      const rows = await adminDb()
        .select({
          day,
          totalTokens: sum(usageEvents.totalTokens),
          inputTokens: sum(usageEvents.inputTokens),
          outputTokens: sum(usageEvents.outputTokens),
          cacheReadTokens: sum(usageEvents.cacheReadTokens),
          cacheWriteTokens: sum(usageEvents.cacheWriteTokens),
          costUsd: sum(usageEvents.costUsd),
          inputCostUsd: sql<string>`sum(coalesce(${usageEvents.inputTokens} * ${modelPrices.inputCostPerMillionUsd} / 1000000, 0))`,
          outputCostUsd: sql<string>`sum(coalesce(${usageEvents.outputTokens} * ${modelPrices.outputCostPerMillionUsd} / 1000000, 0))`,
          cacheCostUsd: sql<string>`sum(coalesce((${usageEvents.cacheReadTokens} * ${modelPrices.cacheReadCostPerMillionUsd} + ${usageEvents.cacheWriteTokens} * ${modelPrices.cacheWriteCostPerMillionUsd}) / 1000000, 0))`
        })
        .from(usageEvents)
        .innerJoin(tools, eq(usageEvents.toolId, tools.id))
        .leftJoin(modelPrices, eq(usageEvents.model, modelPrices.model))
        .where(eventWhere(filters))
        .groupBy(day)
        .orderBy(day);

      const toolRows = await adminDb()
        .select({
          day,
          toolSlug: tools.slug,
          toolName: tools.displayName,
          totalTokens: sum(usageEvents.totalTokens),
          costUsd: sum(usageEvents.costUsd)
        })
        .from(usageEvents)
        .innerJoin(tools, eq(usageEvents.toolId, tools.id))
        .where(eventWhere(filters))
        .groupBy(day, tools.slug, tools.displayName);

      const toolUsagesByDay: Record<string, Array<{ toolSlug: string; toolName: string; totalTokens: number; costUsd: number }>> = {};
      for (const toolRow of toolRows) {
        if (toolRow.day) {
          if (!toolUsagesByDay[toolRow.day]) {
            toolUsagesByDay[toolRow.day] = [];
          }
          toolUsagesByDay[toolRow.day].push({
            toolSlug: toolRow.toolSlug,
            toolName: toolRow.toolName,
            totalTokens: numberFromAggregate(toolRow.totalTokens),
            costUsd: numberFromAggregate(toolRow.costUsd)
          });
        }
      }

      return {
        points: rows.map((row) => ({
          day: row.day,
          totalTokens: numberFromAggregate(row.totalTokens),
          inputTokens: numberFromAggregate(row.inputTokens),
          outputTokens: numberFromAggregate(row.outputTokens),
          cacheReadTokens: numberFromAggregate(row.cacheReadTokens),
          cacheWriteTokens: numberFromAggregate(row.cacheWriteTokens),
          costUsd: numberFromAggregate(row.costUsd),
          inputCostUsd: numberFromAggregate(row.inputCostUsd),
          outputCostUsd: numberFromAggregate(row.outputCostUsd),
          cacheCostUsd: numberFromAggregate(row.cacheCostUsd),
          toolUsages: toolUsagesByDay[row.day ?? ""] ?? []
        }))
      };
    },

    async getProjectRatios(filters) {
      const day = reportingDaySql(filters);
      const [dailyRows, totalRows] = await Promise.all([
        adminDb()
          .select({
            day,
            id: projects.id,
            displayName: projects.displayName,
            repoHash: projects.repoHash,
            totalTokens: sum(usageEvents.totalTokens)
          })
          .from(usageEvents)
          .innerJoin(tools, eq(usageEvents.toolId, tools.id))
          .innerJoin(projects, eq(usageEvents.projectId, projects.id))
          .where(eventWhere({ ...filters, projectId: undefined }))
          .groupBy(day, projects.id, projects.displayName, projects.repoHash)
          .orderBy(day),
        adminDb()
          .select({
            day: sql<string>`''`,
            id: projects.id,
            displayName: projects.displayName,
            repoHash: projects.repoHash,
            totalTokens: sum(usageEvents.totalTokens)
          })
          .from(usageEvents)
          .innerJoin(tools, eq(usageEvents.toolId, tools.id))
          .innerJoin(projects, eq(usageEvents.projectId, projects.id))
          .where(
            eventWhere({
              tool: filters.tool,
              deviceId: filters.deviceId,
              model: filters.model
            })
          )
          .groupBy(projects.id, projects.displayName, projects.repoHash)
      ]);

      return createProjectRatioResponse(dailyRows, totalRows);
    },

    async getEvents(filters) {
      const limit = clampLimit(filters.limit);
      const offset = Math.max(0, filters.offset ?? 0);
      const where = eventWhere(filters);
      const orderBy = eventOrderBy(filters.sortBy, filters.sortDir);
      const rows = await adminDb()
        .select({
          id: usageEvents.id,
          occurredAt: usageEvents.occurredAt,
          tool: tools.slug,
          deviceId: usageEvents.deviceId,
          projectId: usageEvents.projectId,
          model: sql<string>`coalesce(${usageEvents.model}, 'unknown')`,
          inputTokens: usageEvents.inputTokens,
          outputTokens: usageEvents.outputTokens,
          cacheReadTokens: usageEvents.cacheReadTokens,
          cacheWriteTokens: usageEvents.cacheWriteTokens,
          totalTokens: usageEvents.totalTokens,
          costUsd: usageEvents.costUsd
        })
        .from(usageEvents)
        .innerJoin(tools, eq(usageEvents.toolId, tools.id))
        .where(where)
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset);
      const [totalRow] = await adminDb()
        .select({ total: count() })
        .from(usageEvents)
        .innerJoin(tools, eq(usageEvents.toolId, tools.id))
        .where(where);

      return {
        rows: rows.map((row) => ({ ...row, costUsd: numberFromAggregate(row.costUsd) })),
        total: totalRow?.total ?? 0
      };
    },

    async listDevices(filters) {
      const usageTotals = adminDb()
        .select({
          deviceId: usageEvents.deviceId,
          totalTokens: sum(usageEvents.totalTokens).as("total_tokens"),
          costUsd: sum(usageEvents.costUsd).as("cost_usd"),
          eventCount: count().as("event_count")
        })
        .from(usageEvents)
        .innerJoin(tools, eq(usageEvents.toolId, tools.id))
        .where(eventWhere(filters))
        .groupBy(usageEvents.deviceId)
        .as("device_usage_totals");
      const rows = await adminDb()
        .select({
          id: devices.id,
          name: devices.name,
          os: devices.os,
          hostnameHash: devices.hostnameHash,
          lastSeenAt: devices.lastSeenAt,
          disabledAt: devices.disabledAt,
          createdAt: devices.createdAt,
          totalTokens: usageTotals.totalTokens,
          costUsd: usageTotals.costUsd,
          eventCount: usageTotals.eventCount
        })
        .from(devices)
        .leftJoin(usageTotals, eq(devices.id, usageTotals.deviceId))
        .orderBy(desc(devices.createdAt));

      return {
        rows: rows.map((row) => ({
          ...row,
          totalTokens: numberFromAggregate(row.totalTokens),
          costUsd: numberFromAggregate(row.costUsd),
          eventCount: numberFromAggregate(row.eventCount)
        }))
      };
    },

    async createDevice(input) {
      const [device] = await adminDb()
        .insert(devices)
        .values({
          name: input.name,
          os: input.os,
          hostnameHash: input.hostnameHash,
          deviceTokenHash: hashToken(input.token)
        })
        .returning({
          id: devices.id,
          name: devices.name,
          os: devices.os,
          hostnameHash: devices.hostnameHash,
          createdAt: devices.createdAt
        });

      if (!device) {
        throw new Error("failed to create device");
      }

      return { ...device, token: input.token };
    },

    async disableDevice(id) {
      const [device] = await adminDb()
        .update(devices)
        .set({
          disabledAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(devices.id, id))
        .returning({
          id: devices.id,
          disabledAt: devices.disabledAt
        });

      return device ?? null;
    },

    async listProjects(filters) {
      const usageTotals = adminDb()
        .select({
          projectId: usageEvents.projectId,
          totalTokens: sum(usageEvents.totalTokens).as("total_tokens"),
          costUsd: sum(usageEvents.costUsd).as("cost_usd"),
          eventCount: count().as("event_count")
        })
        .from(usageEvents)
        .innerJoin(tools, eq(usageEvents.toolId, tools.id))
        .where(eventWhere(filters))
        .groupBy(usageEvents.projectId)
        .as("project_usage_totals");
      const rows = await adminDb()
        .select({
          id: projects.id,
          displayName: projects.displayName,
          repoHash: projects.repoHash,
          remoteHash: projects.remoteHash,
          pathHash: projects.pathHash,
          createdAt: projects.createdAt,
          updatedAt: projects.updatedAt,
          totalTokens: usageTotals.totalTokens,
          costUsd: usageTotals.costUsd,
          eventCount: usageTotals.eventCount
        })
        .from(projects)
        .leftJoin(usageTotals, eq(projects.id, usageTotals.projectId))
        .orderBy(desc(projects.updatedAt));

      return {
        rows: sortProjectRows(mergeProjectRowsByRepoHash(rows), filters?.sortBy, filters?.sortDir)
      };
    },

    async listTools() {
      const rows = await adminDb()
        .select({
          id: tools.id,
          slug: tools.slug,
          displayName: tools.displayName,
          createdAt: tools.createdAt
        })
        .from(tools)
        .orderBy(tools.slug);

      return { rows };
    },

    async listModels(filters) {
      const rows = await adminDb()
        .select({
          model: sql<string>`coalesce(${usageEvents.model}, 'unknown')`
        })
        .from(usageEvents)
        .innerJoin(tools, eq(usageEvents.toolId, tools.id))
        .where(eventWhere(filters))
        .groupBy(sql`coalesce(${usageEvents.model}, 'unknown')`)
        .orderBy(sql`coalesce(${usageEvents.model}, 'unknown')`);

      return { rows };
    },

    async listModelPrices() {
      const rows = await adminDb()
        .select({
          id: modelPrices.id,
          model: modelPrices.model,
          inputCostPerMillionUsd: modelPrices.inputCostPerMillionUsd,
          outputCostPerMillionUsd: modelPrices.outputCostPerMillionUsd,
          cacheReadCostPerMillionUsd: modelPrices.cacheReadCostPerMillionUsd,
          cacheWriteCostPerMillionUsd: modelPrices.cacheWriteCostPerMillionUsd,
          createdAt: modelPrices.createdAt,
          updatedAt: modelPrices.updatedAt
        })
        .from(modelPrices)
        .orderBy(modelPrices.model);

      return { rows: rows.map(normalizeModelPriceRow) };
    },

    async upsertModelPrice(input) {
      const [row] = await adminDb()
        .insert(modelPrices)
        .values({
          model: input.model,
          inputCostPerMillionUsd: String(input.inputCostPerMillionUsd),
          outputCostPerMillionUsd: String(input.outputCostPerMillionUsd),
          cacheReadCostPerMillionUsd: String(input.cacheReadCostPerMillionUsd),
          cacheWriteCostPerMillionUsd: String(input.cacheWriteCostPerMillionUsd)
        })
        .onConflictDoUpdate({
          target: modelPrices.model,
          set: {
            inputCostPerMillionUsd: String(input.inputCostPerMillionUsd),
            outputCostPerMillionUsd: String(input.outputCostPerMillionUsd),
            cacheReadCostPerMillionUsd: String(input.cacheReadCostPerMillionUsd),
            cacheWriteCostPerMillionUsd: String(input.cacheWriteCostPerMillionUsd),
            updatedAt: new Date()
          }
        })
        .returning({
          id: modelPrices.id,
          model: modelPrices.model,
          inputCostPerMillionUsd: modelPrices.inputCostPerMillionUsd,
          outputCostPerMillionUsd: modelPrices.outputCostPerMillionUsd,
          cacheReadCostPerMillionUsd: modelPrices.cacheReadCostPerMillionUsd,
          cacheWriteCostPerMillionUsd: modelPrices.cacheWriteCostPerMillionUsd,
          createdAt: modelPrices.createdAt,
          updatedAt: modelPrices.updatedAt
        });

      if (!row) {
        throw new Error("failed to save model price");
      }

      return normalizeModelPriceRow(row);
    },

    async deleteModelPrice(id) {
      const [row] = await adminDb()
        .delete(modelPrices)
        .where(eq(modelPrices.id, id))
        .returning({ id: modelPrices.id });

      return row ?? null;
    }
  };
}

export function mergeProjectRowsByRepoHash(
  rows: ProjectUsageRow[]
): Array<ProjectUsageRow & { totalTokens: number; costUsd: number; eventCount: number }> {
  const grouped = new Map<
    string,
    ProjectUsageRow & { totalTokens: number; costUsd: number; eventCount: number }
  >();

  for (const row of rows) {
    const key = row.repoHash ? `repo:${row.repoHash}` : `project:${row.id}`;
    const totalTokens = numberFromAggregate(row.totalTokens);
    const costUsd = numberFromAggregate(row.costUsd);
    const eventCount = numberFromAggregate(row.eventCount);
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, {
        ...row,
        totalTokens,
        costUsd,
        eventCount
      });
      continue;
    }

    existing.totalTokens += totalTokens;
    existing.costUsd += costUsd;
    existing.eventCount += eventCount;
    if (row.updatedAt > existing.updatedAt) {
      existing.updatedAt = row.updatedAt;
    }
  }

  return [...grouped.values()];
}

export function mergeProjectRatioRows(
  rows: ProjectRatioRow[]
): Array<{ day: string } & ProjectRatioItem> {
  const grouped = new Map<string, { day: string } & ProjectRatioItem>();

  for (const row of rows) {
    const projectKey = row.repoHash ? `repo:${row.repoHash}` : `project:${row.id}`;
    const key = `${row.day}|${projectKey}`;
    const existing = grouped.get(key);

    if (existing) {
      existing.totalTokens += numberFromAggregate(row.totalTokens);
      continue;
    }

    grouped.set(key, {
      day: row.day,
      projectKey,
      projectName: row.displayName,
      totalTokens: numberFromAggregate(row.totalTokens)
    });
  }

  return [...grouped.values()];
}

export function createProjectRatioResponse(
  dailyRows: ProjectRatioRow[],
  totalRows: ProjectRatioRow[]
): ProjectRatioResponse {
  const daily = new Map<string, ProjectRatioItem[]>();

  for (const row of mergeProjectRatioRows(dailyRows)) {
    const projectsForDay = daily.get(row.day) ?? [];
    projectsForDay.push({
      projectKey: row.projectKey,
      projectName: row.projectName,
      totalTokens: row.totalTokens
    });
    daily.set(row.day, projectsForDay);
  }

  return {
    daily: [...daily].map(([day, projects]) => ({ day, projects })),
    total: mergeProjectRatioRows(totalRows).map(({ day: _day, ...project }) => project)
  };
}

function eventWhere(filters: Partial<UsageFilters> | undefined) {
  const from = filters?.from ? reportingDayUtcRange(filters.from, reportingTimeZone(filters)) : undefined;
  const to = filters?.to ? reportingDayUtcRange(filters.to, reportingTimeZone(filters)) : undefined;

  return and(
    from ? gte(usageEvents.occurredAt, from.start) : undefined,
    to ? lte(usageEvents.occurredAt, to.end) : undefined,
    optionalEq(tools.slug, filters?.tool),
    optionalEq(usageEvents.deviceId, filters?.deviceId),
    optionalEq(usageEvents.projectId, filters?.projectId),
    optionalModelEq(filters?.model)
  );
}

export function reportingDaySql(filters: UsageFilters) {
  return sql<string>`to_char(${usageEvents.occurredAt} AT TIME ZONE ${reportingTimeZoneSql(
    reportingTimeZone(filters)
  )}, 'YYYY-MM-DD')`;
}

function reportingTimeZone(filters: Partial<UsageFilters> | undefined): ReportingTimeZone {
  return filters?.timeZone ?? defaultReportingTimeZone;
}

function reportingTimeZoneSql(timeZone: ReportingTimeZone) {
  return sql.raw(`'${timeZone}'`);
}

function optionalEq<TColumn>(column: TColumn, value: string | undefined) {
  return value ? eq(column as never, value) : undefined;
}

function optionalModelEq(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  if (value === "unknown") {
    return or(eq(usageEvents.model, "unknown"), sql`${usageEvents.model} is null`);
  }

  return eq(usageEvents.model, value);
}

function eventOrderBy(sortBy: EventSortBy = "occurredAt", sortDir: SortDir = "desc") {
  const column =
    sortBy === "totalTokens"
      ? usageEvents.totalTokens
      : sortBy === "inputTokens"
        ? usageEvents.inputTokens
        : sortBy === "outputTokens"
          ? usageEvents.outputTokens
          : sortBy === "cacheTokens"
            ? sql<number>`${usageEvents.cacheReadTokens} + ${usageEvents.cacheWriteTokens}`
            : sortBy === "costUsd"
              ? usageEvents.costUsd
              : usageEvents.occurredAt;

  return sortDir === "asc" ? asc(column) : desc(column);
}

function sortProjectRows<
  TRow extends ProjectUsageRow & { totalTokens: number; costUsd: number; eventCount: number }
>(rows: TRow[], sortBy: ProjectSortBy = "updatedAt", sortDir: SortDir = "desc"): TRow[] {
  const direction = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const leftValue = projectSortValue(left, sortBy);
    const rightValue = projectSortValue(right, sortBy);
    if (leftValue === rightValue) {
      return right.updatedAt.getTime() - left.updatedAt.getTime();
    }
    return leftValue > rightValue ? direction : -direction;
  });
}

function projectSortValue(
  row: ProjectUsageRow & { totalTokens: number; costUsd: number; eventCount: number },
  sortBy: ProjectSortBy
): number {
  if (sortBy === "eventCount") return row.eventCount;
  if (sortBy === "totalTokens") return row.totalTokens;
  if (sortBy === "costUsd") return row.costUsd;
  return row.updatedAt.getTime();
}

function numberFromAggregate(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function normalizeModelPriceRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    inputCostPerMillionUsd: numberFromAggregate(row.inputCostPerMillionUsd as string | number | null | undefined),
    outputCostPerMillionUsd: numberFromAggregate(row.outputCostPerMillionUsd as string | number | null | undefined),
    cacheReadCostPerMillionUsd: numberFromAggregate(row.cacheReadCostPerMillionUsd as string | number | null | undefined),
    cacheWriteCostPerMillionUsd: numberFromAggregate(row.cacheWriteCostPerMillionUsd as string | number | null | undefined)
  };
}

function clampLimit(limit: number | undefined): number {
  if (!limit) {
    return 100;
  }

  return Math.min(Math.max(limit, 1), 500);
}

function getDefaultDb(): TokenReportDb {
  if (!defaultDb) {
    defaultDb = createDb().db;
  }

  return defaultDb;
}
