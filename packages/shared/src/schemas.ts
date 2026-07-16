import { z } from "zod";
import { assertSanitizedMetadata } from "./privacy.js";

export const toolSlugSchema = z.enum([
  "codex-cli",
  "codex-vscode-plugin",
  "codex-desktop",
  "other"
]);

export const projectIdentitySchema = z.object({
  displayName: z.string().min(1),
  repoHash: z.string().nullable(),
  remoteHash: z.string().nullable(),
  pathHash: z.string().min(16)
});

export const sanitizedMetadataSchema = z.record(z.string(), z.unknown()).superRefine((metadata, context) => {
  try {
    assertSanitizedMetadata(metadata);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "metadata failed privacy validation"
    });
  }
});

export const usageEventDraftSchema = z.object({
  sourceEventId: z.string().min(12),
  taskId: z.string().min(1).nullable().optional(),
  sourceSessionId: z.string().min(1).optional(),
  toolSlug: toolSlugSchema,
  occurredAt: z.string().datetime(),
  project: projectIdentitySchema,
  model: z.string().nullable(),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable().default(null),
  metadata: sanitizedMetadataSchema.default({})
});

export const taskMetadataDraftSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().trim().min(1).max(500),
  updatedAt: z.string().datetime()
});

export const taskMetadataBatchEnvelopeSchema = z.object({
  tasks: z.array(z.unknown()).max(1000)
});

export const taskMetadataAcknowledgementSchema = z.object({
  inserted: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  rejected: z.array(z.object({
    taskId: z.string(),
    reason: z.string().min(1)
  }))
});

export const ingestBatchSchema = z.object({
  device: z.object({
    name: z.string().min(1),
    os: z.string().min(1),
    hostnameHash: z.string().min(16)
  }),
  events: z.array(usageEventDraftSchema).max(1000)
});

export type ToolSlug = z.infer<typeof toolSlugSchema>;
export type UsageEventDraft = z.infer<typeof usageEventDraftSchema>;
export type IngestBatch = z.infer<typeof ingestBatchSchema>;
export type TaskMetadataDraft = z.infer<typeof taskMetadataDraftSchema>;
export type TaskMetadataBatchEnvelope = z.infer<typeof taskMetadataBatchEnvelopeSchema>;
export type TaskMetadataAcknowledgement = z.infer<typeof taskMetadataAcknowledgementSchema>;
