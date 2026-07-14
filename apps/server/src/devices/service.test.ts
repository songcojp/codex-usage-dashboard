import { describe, expect, it } from "vitest";
import { DeviceAuthError, requireDeviceByTokenHash } from "./service.js";

function dbReturning(device: unknown) {
  return {
    query: {
      devices: {
        findFirst: async () => device
      }
    }
  };
}

describe("requireDeviceByTokenHash", () => {
  it("returns an enabled device by token hash", async () => {
    await expect(
      requireDeviceByTokenHash(
        dbReturning({ id: "device-1", deviceTokenHash: "hash", disabledAt: null }) as never,
        "hash"
      )
    ).resolves.toMatchObject({ id: "device-1" });
  });

  it("throws an auth error when the token hash is missing", async () => {
    await expect(requireDeviceByTokenHash(dbReturning(undefined) as never, "missing")).rejects.toBeInstanceOf(
      DeviceAuthError
    );
  });

  it("throws an auth error when the device is disabled", async () => {
    await expect(
      requireDeviceByTokenHash(
        dbReturning({ id: "device-1", deviceTokenHash: "hash", disabledAt: new Date() }) as never,
        "hash"
      )
    ).rejects.toBeInstanceOf(DeviceAuthError);
  });
});
