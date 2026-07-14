import fs from "node:fs/promises";
import crypto from "node:crypto";

const maxIdentityLineBytes = 1024 * 1024;

export type FileObservation = {
  path: string;
  identity: string | null;
  fallbackSignature: string | null;
  size: number;
  mtimeMs: number;
};

export async function observeFile(filePath: string): Promise<FileObservation> {
  const stat = await fs.stat(filePath, { bigint: true });
  const primary = primaryIdentity(stat);
  let fallbackSignature: string | null = null;

  if (!primary) {
    const firstLineHash = await hashFirstCompleteLine(filePath);
    if (firstLineHash) {
      fallbackSignature = `fallback:${stat.birthtimeNs}:${firstLineHash}`;
    }
  }

  return {
    path: filePath,
    identity: primary ?? fallbackSignature,
    fallbackSignature,
    size: safeNumber(stat.size, "file size"),
    mtimeMs: Number(stat.mtimeNs / 1_000_000n)
  };
}

function primaryIdentity(stat: Awaited<ReturnType<typeof fs.stat>> & { dev: bigint; ino: bigint; birthtimeNs: bigint }): string | null {
  if (stat.dev <= 0n || stat.ino <= 0n || stat.birthtimeNs <= 0n) return null;
  return `dev:${stat.dev}:ino:${stat.ino}:birth:${stat.birthtimeNs}`;
}

async function hashFirstCompleteLine(filePath: string): Promise<string | null> {
  const handle = await fs.open(filePath, "r");
  const buffer = Buffer.alloc(maxIdentityLineBytes + 1);
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    return newline === -1
      ? null
      : crypto.createHash("sha256").update(buffer.subarray(0, newline)).digest("hex");
  } finally {
    await handle.close();
  }
}

function safeNumber(value: bigint, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${field} exceeds the supported range`);
  return result;
}
