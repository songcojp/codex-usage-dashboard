import crypto from "node:crypto";
import fs from "node:fs/promises";
import { primaryIdentity } from "./file-identity.js";

const defaultMaxBytes = 4 * 1024 * 1024;
const defaultMaxPendingBytes = 1024 * 1024;

export type LineCursor = {
  offset: number;
  nextLineNumber: number;
  pendingBase64: string;
  discardUntilNewline: boolean;
};

export type LineFrame = {
  text: string;
  lineNumber: number;
  checkpoint: LineCursor;
  finalTail?: boolean;
};

export type DiscardedLine = {
  lineNumber: number;
  category: "line-too-large";
  sourceHash: string;
};

export function emptyLineCursor(): LineCursor {
  return { offset: 0, nextLineNumber: 1, pendingBase64: "", discardUntilNewline: false };
}

export async function readLineChunk(input: {
  filePath: string;
  cursor: LineCursor;
  maxBytes?: number;
  maxPendingBytes?: number;
  expectedIdentity?: string;
  finalTail?: boolean;
}): Promise<{ lines: LineFrame[]; discarded: DiscardedLine[]; cursor: LineCursor; observedSize: number; observedMtimeMs: number }> {
  const maxBytes = input.maxBytes ?? defaultMaxBytes;
  const maxPendingBytes = input.maxPendingBytes ?? defaultMaxPendingBytes;
  const handle = await fs.open(input.filePath, "r");
  let bytesRead = 0;
  let observedSize = 0;
  let observedMtimeMs = 0;
  const chunk = Buffer.alloc(maxBytes);
  try {
    const before = await handle.stat({ bigint: true });
    verifyIdentity(input.expectedIdentity, primaryIdentity(before));
    ({ bytesRead } = await handle.read(chunk, 0, maxBytes, input.cursor.offset));
    const after = await handle.stat({ bigint: true });
    verifyIdentity(input.expectedIdentity, primaryIdentity(after));
    if (primaryIdentity(before) !== primaryIdentity(after) || after.size < BigInt(input.cursor.offset + bytesRead)) {
      throw new Error("source identity changed during read");
    }
    observedSize = safeNumber(after.size);
    observedMtimeMs = Number(after.mtimeNs / 1_000_000n);
  } finally {
    await handle.close();
  }

  const fresh = chunk.subarray(0, bytesRead);
  let pending = Buffer.from(input.cursor.pendingBase64, "base64");
  let combined = Buffer.concat([pending, fresh]);
  let logicalStart = input.cursor.offset - pending.length;
  let nextLineNumber = input.cursor.nextLineNumber;
  let discardUntilNewline = input.cursor.discardUntilNewline;
  const lines: LineFrame[] = [];
  const discarded: DiscardedLine[] = [];

  if (discardUntilNewline) {
    const newline = combined.indexOf(0x0a);
    if (newline === -1) {
      return {
        lines,
        discarded,
        cursor: input.finalTail
          ? { offset: input.cursor.offset + bytesRead, nextLineNumber: nextLineNumber + 1, pendingBase64: "", discardUntilNewline: false }
          : { offset: input.cursor.offset + bytesRead, nextLineNumber, pendingBase64: "", discardUntilNewline: true },
        observedSize,
        observedMtimeMs
      };
    }
    combined = combined.subarray(newline + 1);
    logicalStart += newline + 1;
    nextLineNumber += 1;
    discardUntilNewline = false;
  }

  let frameStart = 0;
  for (;;) {
    const newline = combined.indexOf(0x0a, frameStart);
    if (newline === -1) break;
    let bytes = combined.subarray(frameStart, newline);
    if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, -1);
    const lineNumber = nextLineNumber++;
    const checkpoint = {
      offset: logicalStart + newline + 1,
      nextLineNumber,
      pendingBase64: "",
      discardUntilNewline: false
    };
    if (bytes.length > maxPendingBytes) {
      discarded.push({ lineNumber, category: "line-too-large", sourceHash: hash(bytes) });
    } else {
      lines.push({ text: bytes.toString("utf8"), lineNumber, checkpoint });
    }
    frameStart = newline + 1;
  }

  pending = combined.subarray(frameStart);
  if (pending.length > maxPendingBytes) {
    discarded.push({ lineNumber: nextLineNumber, category: "line-too-large", sourceHash: hash(pending) });
    pending = Buffer.alloc(0);
    discardUntilNewline = true;
  }

  if (input.finalTail && pending.length > 0 && !discardUntilNewline) {
    let bytes = pending;
    if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, -1);
    const lineNumber = nextLineNumber++;
    const checkpoint = {
      offset: input.cursor.offset + bytesRead,
      nextLineNumber,
      pendingBase64: "",
      discardUntilNewline: false
    };
    lines.push({ text: bytes.toString("utf8"), lineNumber, checkpoint, finalTail: true });
    pending = Buffer.alloc(0);
  }

  return {
    lines,
    discarded,
    cursor: {
      offset: input.cursor.offset + bytesRead,
      nextLineNumber,
      pendingBase64: pending.toString("base64"),
      discardUntilNewline
    },
    observedSize,
    observedMtimeMs
  };
}

function verifyIdentity(expected: string | undefined, actual: string | null): void {
  if (expected?.startsWith("dev:") && expected !== actual) throw new Error("source identity changed before read");
}

function safeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("source size exceeds supported range");
  return result;
}

function hash(value: Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
