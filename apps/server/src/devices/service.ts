import { eq } from "drizzle-orm";
import type { TokenReportDb } from "../db/client.js";
import { devices } from "../db/schema.js";

export type DeviceLookupDb = Pick<TokenReportDb, "query">;

export class DeviceAuthError extends Error {
  constructor(message = "invalid or disabled device token") {
    super(message);
    this.name = "DeviceAuthError";
  }
}

export async function requireDeviceByTokenHash(db: DeviceLookupDb, tokenHash: string) {
  const device = await db.query.devices.findFirst({
    where: eq(devices.deviceTokenHash, tokenHash)
  });

  if (!device || device.disabledAt) {
    throw new DeviceAuthError();
  }

  return device;
}
