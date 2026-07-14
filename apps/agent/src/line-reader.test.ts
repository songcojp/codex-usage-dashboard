import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyLineCursor, readLineChunk } from "./line-reader.js";

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-lines-"));
  return path.join(dir, "usage.jsonl");
}

describe("incremental line reader", () => {
  it("frames UTF-8 and trailing bytes without reading them twice", async () => {
    const filePath = await tempFile();
    await fs.writeFile(filePath, Buffer.from('one\n{"text":"你'));

    const first = await readLineChunk({ filePath, cursor: emptyLineCursor() });
    expect(first.lines.map((line) => line.text)).toEqual(["one"]);
    expect(first.cursor.offset).toBe((await fs.stat(filePath)).size);
    expect(Buffer.from(first.cursor.pendingBase64, "base64").toString("utf8")).toBe('{"text":"你');

    await fs.appendFile(filePath, Buffer.from('好"}\n'));
    const second = await readLineChunk({ filePath, cursor: first.cursor });
    expect(second.lines.map((line) => line.text)).toEqual(['{"text":"你好"}']);
    expect(second.lines[0]?.lineNumber).toBe(2);
    expect(second.cursor.pendingBase64).toBe("");
  });

  it("counts empty CRLF-terminated physical lines", async () => {
    const filePath = await tempFile();
    await fs.writeFile(filePath, "first\r\n\r\nthird\n", "utf8");

    const result = await readLineChunk({ filePath, cursor: emptyLineCursor() });

    expect(result.lines.map(({ text, lineNumber }) => ({ text, lineNumber }))).toEqual([
      { text: "first", lineNumber: 1 },
      { text: "", lineNumber: 2 },
      { text: "third", lineNumber: 3 }
    ]);
    expect(result.cursor.nextLineNumber).toBe(4);
  });

  it("discards an oversized physical line and resumes at the next newline", async () => {
    const filePath = await tempFile();
    await fs.writeFile(filePath, "oversized\nok\n", "utf8");

    const result = await readLineChunk({
      filePath,
      cursor: emptyLineCursor(),
      maxPendingBytes: 4
    });

    expect(result.discarded).toHaveLength(1);
    expect(result.discarded[0]).toMatchObject({ lineNumber: 1, category: "line-too-large" });
    expect(result.lines.map((line) => line.text)).toEqual(["ok"]);
    expect(JSON.stringify(result.discarded)).not.toContain("oversized");
  });
});
