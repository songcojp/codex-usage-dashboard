import { describe, expect, it, vi } from "vitest";

import {
  parseExactDuplicateCliArgs,
  runExactDuplicateCli
} from "./exact-duplicates-cli.js";

describe("exact duplicate maintenance CLI", () => {
  it("accepts audit mode without confirmation", () => {
    expect(parseExactDuplicateCliArgs(["--audit"])).toEqual({ mode: "audit", confirm: false });
  });

  it("requires explicit confirmation for cleanup mode", () => {
    expect(() => parseExactDuplicateCliArgs(["--cleanup"])).toThrow(
      "cleanup mode requires --confirm"
    );
    expect(parseExactDuplicateCliArgs(["--cleanup", "--confirm"])).toEqual({
      mode: "cleanup",
      confirm: true
    });
  });

  it("rejects missing or conflicting modes", () => {
    expect(() => parseExactDuplicateCliArgs([])).toThrow("choose exactly one mode");
    expect(() => parseExactDuplicateCliArgs(["--audit", "--cleanup"])).toThrow(
      "choose exactly one mode"
    );
  });

  it("writes one JSON result for audit mode", async () => {
    const audit = vi.fn().mockResolvedValue({ strictExcessRows: 0 });
    const cleanup = vi.fn();
    const write = vi.fn();

    await expect(runExactDuplicateCli({ args: ["--audit"], audit, cleanup, write })).resolves.toEqual({
      strictExcessRows: 0
    });
    expect(write).toHaveBeenCalledWith('{"strictExcessRows":0}');
    expect(cleanup).not.toHaveBeenCalled();
  });
});
