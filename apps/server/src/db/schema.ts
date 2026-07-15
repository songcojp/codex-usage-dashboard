import { relations } from "drizzle-orm";
import {
  bigint,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  os: text("os").notNull(),
  hostnameHash: text("hostname_hash").notNull(),
  deviceTokenHash: text("device_token_hash").notNull().unique(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const tools = pgTable("tools", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: text("display_name").notNull(),
    repoHash: text("repo_hash").notNull().default(""),
    remoteHash: text("remote_hash").notNull().default(""),
    pathHash: text("path_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("projects_identity_idx").on(table.repoHash, table.remoteHash, table.pathHash)
  ]
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow().notNull(),
    toolId: uuid("tool_id")
      .references(() => tools.id)
      .notNull(),
    deviceId: uuid("device_id")
      .references(() => devices.id)
      .notNull(),
    projectId: uuid("project_id")
      .references(() => projects.id)
      .notNull(),
    sourceEventId: text("source_event_id").notNull(),
    taskId: text("task_id").notNull(),
    model: text("model"),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    totalTokens: bigint("total_tokens", { mode: "number" }).notNull(),
    costUsd: numeric("cost_usd"),
    rawMetaJson: jsonb("raw_meta_json").notNull().default({})
  },
  (table) => [
    uniqueIndex("usage_events_source_unique").on(
      table.deviceId,
      table.toolId,
      table.sourceEventId
    )
  ]
);

export const dailyUsageRollups = pgTable(
  "daily_usage_rollups",
  {
    day: date("day").notNull(),
    toolId: uuid("tool_id")
      .references(() => tools.id)
      .notNull(),
    deviceId: uuid("device_id")
      .references(() => devices.id)
      .notNull(),
    projectId: uuid("project_id")
      .references(() => projects.id)
      .notNull(),
    model: text("model").notNull().default("unknown"),
    eventCount: integer("event_count").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    totalTokens: bigint("total_tokens", { mode: "number" }).notNull().default(0),
    costUsd: numeric("cost_usd").notNull().default("0")
  },
  (table) => [
    primaryKey({
      columns: [table.day, table.toolId, table.deviceId, table.projectId, table.model],
      name: "daily_usage_rollups_pk"
    })
  ]
);

export const modelPrices = pgTable(
  "model_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toolId: uuid("tool_id")
      .references(() => tools.id),
    model: text("model").notNull(),
    inputCostPerMillionUsd: numeric("input_cost_per_million_usd").notNull().default("0"),
    outputCostPerMillionUsd: numeric("output_cost_per_million_usd").notNull().default("0"),
    cacheReadCostPerMillionUsd: numeric("cache_read_cost_per_million_usd").notNull().default("0"),
    cacheWriteCostPerMillionUsd: numeric("cache_write_cost_per_million_usd").notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("model_prices_model_unique").on(table.model)
  ]
);

export const deviceRelations = relations(devices, ({ many }) => ({
  events: many(usageEvents),
  dailyRollups: many(dailyUsageRollups)
}));

export const toolRelations = relations(tools, ({ many }) => ({
  events: many(usageEvents),
  dailyRollups: many(dailyUsageRollups),
  modelPrices: many(modelPrices)
}));

export const projectRelations = relations(projects, ({ many }) => ({
  events: many(usageEvents),
  dailyRollups: many(dailyUsageRollups)
}));

export const usageEventRelations = relations(usageEvents, ({ one }) => ({
  device: one(devices, {
    fields: [usageEvents.deviceId],
    references: [devices.id]
  }),
  tool: one(tools, {
    fields: [usageEvents.toolId],
    references: [tools.id]
  }),
  project: one(projects, {
    fields: [usageEvents.projectId],
    references: [projects.id]
  })
}));

export const dailyUsageRollupRelations = relations(dailyUsageRollups, ({ one }) => ({
  device: one(devices, {
    fields: [dailyUsageRollups.deviceId],
    references: [devices.id]
  }),
  tool: one(tools, {
    fields: [dailyUsageRollups.toolId],
    references: [tools.id]
  }),
  project: one(projects, {
    fields: [dailyUsageRollups.projectId],
    references: [projects.id]
  })
}));

export const modelPriceRelations = relations(modelPrices, ({ one }) => ({
  tool: one(tools, {
    fields: [modelPrices.toolId],
    references: [tools.id]
  })
}));
