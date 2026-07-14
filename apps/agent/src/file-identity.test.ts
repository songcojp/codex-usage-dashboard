import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { observeFile } from "./file-identity.js";

describe("file identity", () => {
  it("observes a stable primary identity without exposing file contents", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-file-identity-"));
    const filePath = path.join(dir, "session.jsonl");
    await fs.writeFile(filePath, "private first line\nsecond\n", "utf8");

    const first = await observeFile(filePath);
    const second = await observeFile(filePath);

    expect(first.identity).toBe(second.identity);
    expect(first.identity).toMatch(/^dev:|^fallback:/);
    expect(JSON.stringify(first)).not.toContain("private first line");
    expect(first).toMatchObject({ path: filePath, size: 26 });
  });
});
