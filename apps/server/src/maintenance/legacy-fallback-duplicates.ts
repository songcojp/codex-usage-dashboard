import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { createDb, type TokenReportDb } from "../db/client.js";

export type LegacyFallbackDuplicateAudit = {
  deviceId: string;
  deviceName: string;
  fallbackRows: number;
  fallbackTokens: number;
  matchedRows: number;
  matchedTokens: number;
  ambiguousGroups: number;
  safeToClean: boolean;
};

export type LegacyFallbackDuplicateCleanupStoreResult = {
  batchId: string;
  backedUp: number;
  deleted: number;
  deletedTokens: number;
  rollupsRebuilt: number;
};

export type LegacyFallbackDuplicateCleanupResult = LegacyFallbackDuplicateAudit &
  Omit<LegacyFallbackDuplicateCleanupStoreResult, "batchId"> & {
    executed: boolean;
    batchId: string | null;
  };

export type LegacyFallbackDuplicateStore = {
  audit(): Promise<LegacyFallbackDuplicateAudit>;
  cleanup(expected: {
    expectedRows: number;
    expectedTokens: number;
  }): Promise<LegacyFallbackDuplicateCleanupStoreResult>;
};

export async function auditLegacyFallbackDuplicates(input: {
  deviceId: string;
  store?: LegacyFallbackDuplicateStore;
  db?: TokenReportDb;
}): Promise<LegacyFallbackDuplicateAudit> {
  return withStore(input, (store) => store.audit());
}

export async function cleanupLegacyFallbackDuplicates(input: {
  deviceId: string;
  confirm: boolean;
  store?: LegacyFallbackDuplicateStore;
  db?: TokenReportDb;
}): Promise<LegacyFallbackDuplicateCleanupResult> {
  if (!input.confirm) {
    throw new Error("legacy fallback duplicate cleanup requires explicit confirmation");
  }

  return withStore(input, async (store) => {
    const audit = await store.audit();
    if (audit.fallbackRows === 0) {
      return {
        ...audit,
        executed: false,
        batchId: null,
        backedUp: 0,
        deleted: 0,
        deletedTokens: 0,
        rollupsRebuilt: 0
      };
    }
    if (!audit.safeToClean) {
      throw new Error("not all legacy fallback rows have one-to-one canonical partners");
    }

    const cleaned = await store.cleanup({
      expectedRows: audit.matchedRows,
      expectedTokens: audit.matchedTokens
    });
    if (
      cleaned.backedUp !== audit.matchedRows ||
      cleaned.deleted !== audit.matchedRows ||
      cleaned.deletedTokens !== audit.matchedTokens
    ) {
      throw new Error("legacy fallback duplicate cleanup count mismatch");
    }

    return { ...audit, ...cleaned, executed: true };
  });
}

export function createLegacyFallbackDuplicateStore(
  db: TokenReportDb,
  deviceId: string
): LegacyFallbackDuplicateStore {
  return {
    async audit() {
      const result = await db.execute(legacyFallbackAuditQuery(deviceId));
      return parseAudit(result.rows[0], deviceId);
    },

    cleanup(expected) {
      const batchId = randomUUID();
      return db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE usage_events IN SHARE ROW EXCLUSIVE MODE`);
        const currentResult = await tx.execute(legacyFallbackAuditQuery(deviceId));
        const current = parseAudit(currentResult.rows[0], deviceId);
        if (
          !current.safeToClean ||
          current.matchedRows !== expected.expectedRows ||
          current.matchedTokens !== expected.expectedTokens
        ) {
          throw new Error("legacy fallback duplicate cohort changed after audit");
        }

        const backedUp = await tx.execute(sql`
          WITH target_groups AS (
            SELECT
              event.device_id,
              event.occurred_at,
              event.model,
              event.input_tokens,
              event.output_tokens,
              event.cache_read_tokens,
              event.cache_write_tokens,
              event.total_tokens,
              count(*)::bigint AS event_count
            FROM usage_events event
            INNER JOIN tools tool ON tool.id = event.tool_id
            WHERE event.device_id = ${deviceId}::uuid
              AND tool.slug = 'codex-cli'
              AND event.task_id = 'fallback:' || event.device_id::text
            GROUP BY
              event.device_id,
              event.occurred_at,
              event.model,
              event.input_tokens,
              event.output_tokens,
              event.cache_read_tokens,
              event.cache_write_tokens,
              event.total_tokens
          ), partner_groups AS (
            SELECT
              event.device_id,
              event.occurred_at,
              event.model,
              event.input_tokens,
              event.output_tokens,
              event.cache_read_tokens,
              event.cache_write_tokens,
              event.total_tokens,
              count(*)::bigint AS event_count
            FROM usage_events event
            INNER JOIN tools tool ON tool.id = event.tool_id
            WHERE event.device_id = ${deviceId}::uuid
              AND tool.slug = 'other'
              AND event.task_id <> 'fallback:' || event.device_id::text
            GROUP BY
              event.device_id,
              event.occurred_at,
              event.model,
              event.input_tokens,
              event.output_tokens,
              event.cache_read_tokens,
              event.cache_write_tokens,
              event.total_tokens
          ), safe_groups AS (
            SELECT target.*
            FROM target_groups target
            INNER JOIN partner_groups partner
              ON partner.device_id = target.device_id
              AND partner.occurred_at = target.occurred_at
              AND partner.model IS NOT DISTINCT FROM target.model
              AND partner.input_tokens = target.input_tokens
              AND partner.output_tokens = target.output_tokens
              AND partner.cache_read_tokens = target.cache_read_tokens
              AND partner.cache_write_tokens = target.cache_write_tokens
              AND partner.total_tokens = target.total_tokens
              AND partner.event_count = target.event_count
          ), candidates AS (
            SELECT event.id
            FROM usage_events event
            INNER JOIN tools tool ON tool.id = event.tool_id
            INNER JOIN safe_groups duplicate
              ON duplicate.device_id = event.device_id
              AND duplicate.occurred_at = event.occurred_at
              AND duplicate.model IS NOT DISTINCT FROM event.model
              AND duplicate.input_tokens = event.input_tokens
              AND duplicate.output_tokens = event.output_tokens
              AND duplicate.cache_read_tokens = event.cache_read_tokens
              AND duplicate.cache_write_tokens = event.cache_write_tokens
              AND duplicate.total_tokens = event.total_tokens
            WHERE event.device_id = ${deviceId}::uuid
              AND tool.slug = 'codex-cli'
              AND event.task_id = 'fallback:' || event.device_id::text
          )
          INSERT INTO usage_event_cleanup_backups (batch_id, usage_event_id, row_data)
          SELECT ${batchId}::uuid, event.id, to_jsonb(event)
          FROM usage_events event
          INNER JOIN candidates candidate ON candidate.id = event.id
          RETURNING usage_event_id
        `);
        const deleted = await tx.execute(sql`
          DELETE FROM usage_events event
          USING usage_event_cleanup_backups backup
          WHERE backup.batch_id = ${batchId}::uuid
            AND event.id = backup.usage_event_id
          RETURNING event.id
        `);
        const backedUpCount = resultCount(backedUp);
        const deletedCount = resultCount(deleted);
        if (
          backedUpCount !== expected.expectedRows ||
          deletedCount !== expected.expectedRows ||
          backedUpCount !== deletedCount
        ) {
          throw new Error("legacy fallback duplicate cleanup count mismatch");
        }

        await tx.execute(sql`DELETE FROM daily_usage_rollups`);
        const rebuilt = await tx.execute(sql`
          INSERT INTO daily_usage_rollups (
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
            (occurred_at AT TIME ZONE 'Asia/Tokyo')::date,
            tool_id,
            device_id,
            project_id,
            coalesce(model, 'unknown'),
            count(*)::integer,
            sum(input_tokens),
            sum(output_tokens),
            sum(cache_read_tokens),
            sum(cache_write_tokens),
            sum(total_tokens),
            sum(coalesce(cost_usd, 0))
          FROM usage_events
          GROUP BY
            (occurred_at AT TIME ZONE 'Asia/Tokyo')::date,
            tool_id,
            device_id,
            project_id,
            coalesce(model, 'unknown')
          RETURNING day
        `);

        return {
          batchId,
          backedUp: backedUpCount,
          deleted: deletedCount,
          deletedTokens: expected.expectedTokens,
          rollupsRebuilt: resultCount(rebuilt)
        };
      });
    }
  };
}

function legacyFallbackAuditQuery(deviceId: string) {
  return sql`
    WITH device_scope AS (
      SELECT id, name
      FROM devices
      WHERE id = ${deviceId}::uuid
    ), target_groups AS (
      SELECT
        event.device_id,
        event.occurred_at,
        event.model,
        event.input_tokens,
        event.output_tokens,
        event.cache_read_tokens,
        event.cache_write_tokens,
        event.total_tokens,
        count(*)::bigint AS event_count
      FROM usage_events event
      INNER JOIN tools tool ON tool.id = event.tool_id
      WHERE event.device_id = ${deviceId}::uuid
        AND tool.slug = 'codex-cli'
        AND event.task_id = 'fallback:' || event.device_id::text
      GROUP BY
        event.device_id,
        event.occurred_at,
        event.model,
        event.input_tokens,
        event.output_tokens,
        event.cache_read_tokens,
        event.cache_write_tokens,
        event.total_tokens
    ), partner_groups AS (
      SELECT
        event.device_id,
        event.occurred_at,
        event.model,
        event.input_tokens,
        event.output_tokens,
        event.cache_read_tokens,
        event.cache_write_tokens,
        event.total_tokens,
        count(*)::bigint AS event_count
      FROM usage_events event
      INNER JOIN tools tool ON tool.id = event.tool_id
      WHERE event.device_id = ${deviceId}::uuid
        AND tool.slug = 'other'
        AND event.task_id <> 'fallback:' || event.device_id::text
      GROUP BY
        event.device_id,
        event.occurred_at,
        event.model,
        event.input_tokens,
        event.output_tokens,
        event.cache_read_tokens,
        event.cache_write_tokens,
        event.total_tokens
    ), matched_groups AS (
      SELECT
        target.event_count AS target_count,
        partner.event_count AS partner_count,
        target.total_tokens
      FROM target_groups target
      INNER JOIN partner_groups partner
        ON partner.device_id = target.device_id
        AND partner.occurred_at = target.occurred_at
        AND partner.model IS NOT DISTINCT FROM target.model
        AND partner.input_tokens = target.input_tokens
        AND partner.output_tokens = target.output_tokens
        AND partner.cache_read_tokens = target.cache_read_tokens
        AND partner.cache_write_tokens = target.cache_write_tokens
        AND partner.total_tokens = target.total_tokens
    )
    SELECT
      (SELECT name FROM device_scope) AS device_name,
      (SELECT coalesce(sum(event_count), 0)::bigint FROM target_groups) AS fallback_rows,
      (SELECT coalesce(sum(event_count * total_tokens), 0)::bigint FROM target_groups)
        AS fallback_tokens,
      (SELECT coalesce(sum(least(target_count, partner_count)), 0)::bigint FROM matched_groups)
        AS matched_rows,
      (SELECT coalesce(sum(least(target_count, partner_count) * total_tokens), 0)::bigint
        FROM matched_groups) AS matched_tokens,
      (SELECT count(*)::bigint FROM matched_groups WHERE target_count <> partner_count)
        AS ambiguous_groups
  `;
}

function parseAudit(row: unknown, deviceId: string): LegacyFallbackDuplicateAudit {
  const value = row as Record<string, unknown> | undefined;
  if (!value) throw new Error("legacy fallback duplicate audit returned no result");
  if (typeof value.device_name !== "string" || value.device_name.length === 0) {
    throw new Error("legacy fallback duplicate audit device not found");
  }
  const fallbackRows = safeCount(value.fallback_rows, "fallback rows");
  const fallbackTokens = safeCount(value.fallback_tokens, "fallback tokens");
  const matchedRows = safeCount(value.matched_rows, "matched rows");
  const matchedTokens = safeCount(value.matched_tokens, "matched tokens");
  const ambiguousGroups = safeCount(value.ambiguous_groups, "ambiguous groups");
  return {
    deviceId,
    deviceName: value.device_name,
    fallbackRows,
    fallbackTokens,
    matchedRows,
    matchedTokens,
    ambiguousGroups,
    safeToClean:
      ambiguousGroups === 0 &&
      matchedRows === fallbackRows &&
      matchedTokens === fallbackTokens
  };
}

async function withStore<T>(
  input: {
    deviceId: string;
    store?: LegacyFallbackDuplicateStore;
    db?: TokenReportDb;
  },
  operation: (store: LegacyFallbackDuplicateStore) => Promise<T>
): Promise<T> {
  if (input.store) return operation(input.store);
  if (input.db) {
    return operation(createLegacyFallbackDuplicateStore(input.db, input.deviceId));
  }

  const connection = createDb();
  try {
    return await operation(createLegacyFallbackDuplicateStore(connection.db, input.deviceId));
  } finally {
    await connection.pool.end();
  }
}

function safeCount(value: unknown, label: string): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(String(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`invalid ${label}`);
  }
  return parsed;
}

function resultCount(result: { rowCount?: number | null; rows: unknown[] }): number {
  return result.rowCount ?? result.rows.length;
}
