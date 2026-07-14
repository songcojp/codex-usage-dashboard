import {
  assertSanitizedMetadata,
  ingestBatchSchema,
  sha256Hex,
  type IngestBatch,
  type UsageEventDraft
} from "@codex-usage-dashboard/shared";
import { eq, sql } from "drizzle-orm";
import { createDb, type TokenReportDb } from "../db/client.js";
import { initialTools } from "../db/seed-tools.js";
import { dailyUsageRollups, devices, modelPrices, projects, tools, usageEvents } from "../db/schema.js";
import { requireDeviceByTokenHash } from "../devices/service.js";
import { reportingDayFromTimestamp } from "../reporting-time.js";

export type RejectedRecord = {
  sourceEventId: string;
  reason: string;
};

export type IngestResult = {
  inserted: number;
  duplicates: number;
  rejected: RejectedRecord[];
};

export class IngestValidationError extends Error {
  constructor(message = "invalid ingest batch") {
    super(message);
    this.name = "IngestValidationError";
  }
}

export type RollupMetrics = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ModelPriceRates = {
  inputCostPerMillionUsd: number;
  outputCostPerMillionUsd: number;
  cacheReadCostPerMillionUsd: number;
  cacheWriteCostPerMillionUsd: number;
};

export type NormalizedProjectIdentity = {
  displayName: string;
  repoHash: string;
  remoteHash: string;
  pathHash: string;
};

export type IngestStore = {
  requireDevice(tokenHash: string): Promise<{ id: string }>;
  updateDevice(deviceId: string, device: IngestBatch["device"]): Promise<void>;
  resolveTool(toolSlug: string): Promise<{ id: string }>;
  resolveModelPrice(model: string): Promise<ModelPriceRates | null>;
  upsertProject(project: NormalizedProjectIdentity): Promise<{ id: string }>;
  insertUsageEvent(event: PersistableUsageEvent): Promise<boolean>;
  incrementDailyRollup(event: PersistableUsageEvent): Promise<void>;
};

export type PersistableUsageEvent = UsageEventDraft & {
  deviceId: string;
  toolId: string;
  projectId: string;
};

type IngestBatchInput = {
  tokenHash: string;
  batch: unknown;
  db?: TokenReportDb;
};

type IngestValidatedBatchInput = {
  tokenHash: string;
  batch: IngestBatch;
  store: IngestStore;
};

type DrizzleIngestDb = Pick<TokenReportDb, "insert" | "query" | "update">;

let defaultDb: TokenReportDb | undefined;
const canonicalSpecDrivenProjectName = "Spec-Driven-Autonomous-Coding-System";
const canonicalSpecDrivenRepoHash = sha256Hex(`repo:${canonicalSpecDrivenProjectName}`);
const specDrivenProjectKeys = new Set([
  projectNameKey("agentic-spec-driven-auto-build"),
  projectNameKey(canonicalSpecDrivenProjectName)
]);
const specDrivenRepoHashes = new Set([
  sha256Hex("repo:agentic-spec-driven-auto-build"),
  canonicalSpecDrivenRepoHash
]);
const canonicalSkill2StudioNextProjectName = "skill2studio-next";
const canonicalSkill2StudioNextRepoHash = sha256Hex(`repo:${canonicalSkill2StudioNextProjectName}`);
const skill2StudioNextProjectKeys = new Set([
  projectNameKey("anz"),
  projectNameKey("can"),
  projectNameKey(canonicalSkill2StudioNextProjectName)
]);
const skill2StudioNextRepoHashes = new Set([
  sha256Hex("repo:anz"),
  sha256Hex("repo:can"),
  canonicalSkill2StudioNextRepoHash
]);

export function addRollupMetrics(current: RollupMetrics, event: RollupMetrics): RollupMetrics {
  return {
    totalTokens: current.totalTokens + event.totalTokens,
    inputTokens: current.inputTokens + event.inputTokens,
    outputTokens: current.outputTokens + event.outputTokens,
    cacheReadTokens: current.cacheReadTokens + event.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + event.cacheWriteTokens
  };
}

export function calculateEventCostUsd(
  event: Pick<
    UsageEventDraft,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
  >,
  rates: ModelPriceRates | null
): number {
  if (!rates) {
    return 0;
  }

  const cost =
    (event.inputTokens * rates.inputCostPerMillionUsd +
      event.outputTokens * rates.outputCostPerMillionUsd +
      event.cacheReadTokens * rates.cacheReadCostPerMillionUsd +
      event.cacheWriteTokens * rates.cacheWriteCostPerMillionUsd) /
    1_000_000;

  return Number(cost.toFixed(12));
}

export function summarizeIngestResult(result: IngestResult): IngestResult {
  return {
    inserted: result.inserted,
    duplicates: result.duplicates,
    rejected: result.rejected
  };
}

export async function ingestBatch(input: IngestBatchInput): Promise<IngestResult> {
  const batch = validateBatch(input.batch);
  const db = input.db ?? getDefaultDb();

  return db.transaction(async (tx) =>
    ingestValidatedBatch({
      tokenHash: input.tokenHash,
      batch,
      store: createDrizzleIngestStore(tx)
    })
  );
}

export async function ingestValidatedBatch(input: IngestValidatedBatchInput): Promise<IngestResult> {
  const device = await input.store.requireDevice(input.tokenHash);
  await input.store.updateDevice(device.id, input.batch.device);

  const result: IngestResult = { inserted: 0, duplicates: 0, rejected: [] };

  for (const event of input.batch.events) {
    assertSanitizedMetadata(event.metadata);

    const tool = await input.store.resolveTool(event.toolSlug);
    const model = event.model ?? "unknown";
    const rates = await input.store.resolveModelPrice(model);
    const project = await input.store.upsertProject(normalizeProjectIdentity(event.project));
    const persistableEvent: PersistableUsageEvent = {
      ...event,
      costUsd: calculateEventCostUsd(event, rates),
      deviceId: device.id,
      toolId: tool.id,
      projectId: project.id
    };

    const inserted = await input.store.insertUsageEvent(persistableEvent);
    if (!inserted) {
      result.duplicates += 1;
      continue;
    }

    await input.store.incrementDailyRollup(persistableEvent);
    result.inserted += 1;
  }

  return result;
}

export function validateBatch(input: unknown): IngestBatch {
  const batch = parseBatch(input);

  for (const event of batch.events) {
    try {
      assertSanitizedMetadata(event.metadata);
    } catch {
      throw new IngestValidationError();
    }

    const computedTotal =
      event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens;

    if (computedTotal > 0 && event.totalTokens !== computedTotal) {
      throw new IngestValidationError();
    }
  }

  return batch;
}

export function normalizeProjectIdentity(project: UsageEventDraft["project"]): NormalizedProjectIdentity {
  const isSpecDrivenProject =
    specDrivenProjectKeys.has(projectNameKey(project.displayName)) ||
    (project.repoHash !== null && specDrivenRepoHashes.has(project.repoHash));
  const isSkill2StudioNextProject =
    skill2StudioNextProjectKeys.has(projectNameKey(project.displayName)) ||
    (project.repoHash !== null && skill2StudioNextRepoHashes.has(project.repoHash));
  const canonicalProject = isSpecDrivenProject
    ? {
        displayName: canonicalSpecDrivenProjectName,
        repoHash: canonicalSpecDrivenRepoHash
      }
    : isSkill2StudioNextProject
      ? {
          displayName: canonicalSkill2StudioNextProjectName,
          repoHash: canonicalSkill2StudioNextRepoHash
        }
      : null;
  const displayName = canonicalProject?.displayName ?? project.displayName;
  const repoHash = canonicalProject?.repoHash ?? project.repoHash ?? "";
  const remoteHash = project.remoteHash ?? "";
  const pathHash = remoteHash || canonicalProject?.repoHash || project.pathHash;

  return {
    displayName,
    repoHash,
    remoteHash,
    pathHash
  };
}

export function createDrizzleIngestStore(db: DrizzleIngestDb): IngestStore {
  return {
    async requireDevice(tokenHash) {
      return requireDeviceByTokenHash(db, tokenHash);
    },

    async updateDevice(deviceId, device) {
      await db
        .update(devices)
        .set({
          name: device.name,
          os: device.os,
          hostnameHash: device.hostnameHash,
          lastSeenAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(devices.id, deviceId));
    },

    async resolveTool(toolSlug) {
      const existingTool = await db.query.tools.findFirst({
        where: eq(tools.slug, toolSlug)
      });
      if (existingTool) {
        return existingTool;
      }

      const knownTool = initialTools.find((tool) => tool.slug === toolSlug);
      if (!knownTool) {
        throw new Error(`unknown tool slug: ${toolSlug}`);
      }

      const [insertedTool] = await db
        .insert(tools)
        .values(knownTool)
        .onConflictDoUpdate({
          target: tools.slug,
          set: {
            displayName: knownTool.displayName
          }
        })
        .returning({ id: tools.id });

      if (!insertedTool) {
        throw new Error(`failed to resolve tool: ${toolSlug}`);
      }

      return insertedTool;
    },

    async resolveModelPrice(model) {
      const price = await db.query.modelPrices.findFirst({
        where: eq(modelPrices.model, model)
      });
      if (!price) {
        return null;
      }

      return {
        inputCostPerMillionUsd: Number(price.inputCostPerMillionUsd),
        outputCostPerMillionUsd: Number(price.outputCostPerMillionUsd),
        cacheReadCostPerMillionUsd: Number(price.cacheReadCostPerMillionUsd),
        cacheWriteCostPerMillionUsd: Number(price.cacheWriteCostPerMillionUsd)
      };
    },

    async upsertProject(project) {
      const [upsertedProject] = await db
        .insert(projects)
        .values(project)
        .onConflictDoUpdate({
          target: [projects.repoHash, projects.remoteHash, projects.pathHash],
          set: {
            displayName: project.displayName,
            updatedAt: new Date()
          }
        })
        .returning({ id: projects.id });

      if (!upsertedProject) {
        throw new Error("failed to resolve project");
      }

      return upsertedProject;
    },

    async insertUsageEvent(event) {
      const [insertedEvent] = await db
        .insert(usageEvents)
        .values({
          occurredAt: new Date(event.occurredAt),
          toolId: event.toolId,
          deviceId: event.deviceId,
          projectId: event.projectId,
          sourceEventId: event.sourceEventId,
          model: event.model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheWriteTokens: event.cacheWriteTokens,
          totalTokens: event.totalTokens,
          costUsd: event.costUsd === null ? null : String(event.costUsd),
          rawMetaJson: event.metadata
        })
        .onConflictDoNothing({
          target: [usageEvents.deviceId, usageEvents.toolId, usageEvents.sourceEventId]
        })
        .returning({ id: usageEvents.id });

      return Boolean(insertedEvent);
    },

    async incrementDailyRollup(event) {
      const costUsd = String(event.costUsd ?? 0);

      await db
        .insert(dailyUsageRollups)
        .values({
          day: dayFromTimestamp(event.occurredAt),
          toolId: event.toolId,
          deviceId: event.deviceId,
          projectId: event.projectId,
          model: event.model ?? "unknown",
          eventCount: 1,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheWriteTokens: event.cacheWriteTokens,
          totalTokens: event.totalTokens,
          costUsd
        })
        .onConflictDoUpdate({
          target: [
            dailyUsageRollups.day,
            dailyUsageRollups.toolId,
            dailyUsageRollups.deviceId,
            dailyUsageRollups.projectId,
            dailyUsageRollups.model
          ],
          set: {
            eventCount: sql`${dailyUsageRollups.eventCount} + 1`,
            inputTokens: sql`${dailyUsageRollups.inputTokens} + ${event.inputTokens}`,
            outputTokens: sql`${dailyUsageRollups.outputTokens} + ${event.outputTokens}`,
            cacheReadTokens: sql`${dailyUsageRollups.cacheReadTokens} + ${event.cacheReadTokens}`,
            cacheWriteTokens: sql`${dailyUsageRollups.cacheWriteTokens} + ${event.cacheWriteTokens}`,
            totalTokens: sql`${dailyUsageRollups.totalTokens} + ${event.totalTokens}`,
            costUsd: sql`${dailyUsageRollups.costUsd} + ${costUsd}::numeric`
          }
        });
    }
  };
}

export function dayFromTimestamp(timestamp: string): string {
  return reportingDayFromTimestamp(timestamp);
}

function getDefaultDb(): TokenReportDb {
  if (!defaultDb) {
    defaultDb = createDb().db;
  }

  return defaultDb;
}

function parseBatch(input: unknown): IngestBatch {
  try {
    return ingestBatchSchema.parse(input);
  } catch {
    throw new IngestValidationError();
  }
}

function projectNameKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
