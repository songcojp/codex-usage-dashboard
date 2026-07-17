import { describe, expect, it, vi } from "vitest";

import {
  parseLegacyFallbackDuplicateCliArgs,
  runLegacyFallbackDuplicateCli
} from "./legacy-fallback-duplicates-cli.js";

const deviceId = "56881519-f053-42ea-8602-2e1981da148c";

describe("legacy fallback duplicate maintenance CLI", () => {
  it("accepts audit mode for one validated device UUID", () => {
    expect(
      parseLegacyFallbackDuplicateCliArgs(["--audit", "--device-id", deviceId])
    ).toEqual({ mode: "audit", confirm: false, deviceId });
  });

  it("requires confirmation for cleanup mode", () => {
    expect(() =>
      parseLegacyFallbackDuplicateCliArgs(["--cleanup", "--device-id", deviceId])
    ).toThrow("cleanup mode requires --confirm");
    expect(
      parseLegacyFallbackDuplicateCliArgs([
        "--cleanup",
        "--confirm",
        "--device-id",
        deviceId
      ])
    ).toEqual({ mode: "cleanup", confirm: true, deviceId });
  });

  it("rejects missing or invalid device IDs", () => {
    expect(() => parseLegacyFallbackDuplicateCliArgs(["--audit"])).toThrow(
      "--device-id is required"
    );
    expect(() =>
      parseLegacyFallbackDuplicateCliArgs(["--audit", "--device-id", "not-a-uuid"])
    ).toThrow("--device-id must be a UUID");
  });

  it("writes one JSON result for audit mode", async () => {
    const audit = vi.fn().mockResolvedValue({ matchedRows: 6_190 });
    const cleanup = vi.fn();
    const write = vi.fn();

    await expect(
      runLegacyFallbackDuplicateCli({
        args: ["--audit", "--device-id", deviceId],
        audit,
        cleanup,
        write
      })
    ).resolves.toEqual({ matchedRows: 6_190 });
    expect(audit).toHaveBeenCalledWith({ deviceId });
    expect(write).toHaveBeenCalledWith('{"matchedRows":6190}');
    expect(cleanup).not.toHaveBeenCalled();
  });
});
