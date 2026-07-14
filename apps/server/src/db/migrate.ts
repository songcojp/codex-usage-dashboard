import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

import { createDb } from "./client.js";

export function calculateMigrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export function verifyAppliedMigrationChecksum(
  migrationName: string,
  appliedChecksum: string,
  currentChecksum: string
): void {
  if (appliedChecksum !== currentChecksum) {
    throw new Error(`migration checksum mismatch: ${migrationName}`);
  }
}

function resolveMigrationsDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const localMigrationsDir = join(moduleDir, "migrations");

  if (existsSync(localMigrationsDir)) {
    return localMigrationsDir;
  }

  return join(moduleDir, "../../src/db/migrations");
}

export async function migrate(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  const { pool } = createDb(databaseUrl);

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "_migrations" (
        "name" text PRIMARY KEY,
        "checksum" text NOT NULL,
        "applied_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    const migrationsDir = resolveMigrationsDir();
    const migrationFiles = (await readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of migrationFiles) {
      const sql = await readFile(join(migrationsDir, file), "utf8");
      const checksum = calculateMigrationChecksum(sql);
      const alreadyApplied = await pool.query<{ name: string; checksum: string }>(
        'SELECT "name", "checksum" FROM "_migrations" WHERE "name" = $1',
        [file]
      );

      if (alreadyApplied.rowCount && alreadyApplied.rowCount > 0) {
        verifyAppliedMigrationChecksum(file, alreadyApplied.rows[0].checksum, checksum);
        continue;
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query('INSERT INTO "_migrations" ("name", "checksum") VALUES ($1, $2)', [
          file,
          checksum
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    await pool.query("SELECT 1");
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
