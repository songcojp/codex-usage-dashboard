import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { createDb, type TokenReportDb } from "../db/client.js";

export type ExactDuplicateAudit = {
  broadGroups: number;
  broadExcessRows: number;
  strictGroups: number;
  strictExcessRows: number;
  strictExcessTokens: number;
};

export type ExactDuplicateCleanupStoreResult = {
  batchId: string;
  backedUp: number;
  deleted: number;
  rollupsRebuilt: number;
};

export type ExactDuplicateCleanupResult = ExactDuplicateAudit & Omit<ExactDuplicateCleanupStoreResult, "batchId"> & {
  executed: boolean;
  batchId: string | null;
};

export type ExactDuplicateStore = {
  audit(): Promise<ExactDuplicateAudit>;
  cleanup(): Promise<ExactDuplicateCleanupStoreResult>;
};

export async function auditExactUsageDuplicates(input: {
  store?: ExactDuplicateStore;
  db?: TokenReportDb;
} = {}): Promise<ExactDuplicateAudit> {
  return withStore(input, (store) => store.audit());
}

export async function cleanupExactUsageDuplicates(input: {
  confirm: boolean;
  store?: ExactDuplicateStore;
  db?: TokenReportDb;
}): Promise<ExactDuplicateCleanupResult> {
  if (!input.confirm) {
    throw new Error("exact duplicate cleanup requires explicit confirmation");
  }

  return withStore(input, async (store) => {
    const audit = await store.audit();
    if (audit.strictExcessRows === 0) {
      return {
        ...audit,
        executed: false,
        batchId: null,
        backedUp: 0,
        deleted: 0,
        rollupsRebuilt: 0
      };
    }

    const cleaned = await store.cleanup();
    if (cleaned.backedUp !== cleaned.deleted) {
      throw new Error("exact duplicate cleanup backup/delete count mismatch");
    }

    return { ...audit, ...cleaned, executed: true };
  });
}

export function createExactDuplicateStore(db: TokenReportDb): ExactDuplicateStore {
  return {
    async audit() {
      const result = await db.execute(sql`
        WITH broad AS (
          SELECT count(*)::bigint AS event_count
          FROM usage_events
          GROUP BY device_id, task_id, occurred_at
          HAVING count(*) > 1
        ), strict AS (
          SELECT count(*)::bigint AS event_count, total_tokens
          FROM usage_events
          GROUP BY
            device_id,
            task_id,
            occurred_at,
            tool_id,
            project_id,
            model,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            total_tokens,
            cost_usd
          HAVING count(*) > 1
        )
        SELECT
          (SELECT count(*)::bigint FROM broad) AS broad_groups,
          (SELECT coalesce(sum(event_count - 1), 0)::bigint FROM broad) AS broad_excess_rows,
          (SELECT count(*)::bigint FROM strict) AS strict_groups,
          (SELECT coalesce(sum(event_count - 1), 0)::bigint FROM strict) AS strict_excess_rows,
          (SELECT coalesce(sum((event_count - 1) * total_tokens), 0)::bigint FROM strict)
            AS strict_excess_tokens
      `);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new Error("exact duplicate audit returned no result");
      return {
        broadGroups: safeCount(row.broad_groups, "broad groups"),
        broadExcessRows: safeCount(row.broad_excess_rows, "broad excess rows"),
        strictGroups: safeCount(row.strict_groups, "strict groups"),
        strictExcessRows: safeCount(row.strict_excess_rows, "strict excess rows"),
        strictExcessTokens: safeCount(row.strict_excess_tokens, "strict excess tokens")
      };
    },

    cleanup() {
      const batchId = randomUUID();
      return db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE usage_events IN SHARE ROW EXCLUSIVE MODE`);
        const backedUp = await tx.execute(sql`
          WITH ranked AS (
            SELECT
              id,
              row_number() OVER (
                PARTITION BY
                  device_id,
                  task_id,
                  occurred_at,
                  tool_id,
                  project_id,
                  model,
                  input_tokens,
                  output_tokens,
                  cache_read_tokens,
                  cache_write_tokens,
                  total_tokens,
                  cost_usd
                ORDER BY ingested_at, id
              ) AS duplicate_rank
            FROM usage_events
          )
          INSERT INTO usage_event_cleanup_backups (batch_id, usage_event_id, row_data)
          SELECT ${batchId}::uuid, event.id, to_jsonb(event)
          FROM usage_events event
          INNER JOIN ranked ON ranked.id = event.id
          WHERE ranked.duplicate_rank > 1
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
        if (backedUpCount !== deletedCount) {
          throw new Error("exact duplicate cleanup backup/delete count mismatch");
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
          rollupsRebuilt: resultCount(rebuilt)
        };
      });
    }
  };
}

async function withStore<T>(
  input: { store?: ExactDuplicateStore; db?: TokenReportDb },
  operation: (store: ExactDuplicateStore) => Promise<T>
): Promise<T> {
  if (input.store) return operation(input.store);
  if (input.db) return operation(createExactDuplicateStore(input.db));

  const connection = createDb();
  try {
    return await operation(createExactDuplicateStore(connection.db));
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
