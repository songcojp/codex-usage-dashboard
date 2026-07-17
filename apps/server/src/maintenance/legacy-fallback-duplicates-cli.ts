import { pathToFileURL } from "node:url";

import {
  auditLegacyFallbackDuplicates,
  cleanupLegacyFallbackDuplicates
} from "./legacy-fallback-duplicates.js";

export type LegacyFallbackDuplicateCliOptions = {
  mode: "audit" | "cleanup";
  confirm: boolean;
  deviceId: string;
};

export function parseLegacyFallbackDuplicateCliArgs(
  args: string[]
): LegacyFallbackDuplicateCliOptions {
  const audit = args.includes("--audit");
  const cleanup = args.includes("--cleanup");
  if (Number(audit) + Number(cleanup) !== 1) {
    throw new Error("choose exactly one mode: --audit or --cleanup");
  }

  const confirm = args.includes("--confirm");
  if (cleanup && !confirm) throw new Error("cleanup mode requires --confirm");

  const deviceFlag = args.indexOf("--device-id");
  if (deviceFlag === -1 || !args[deviceFlag + 1]) {
    throw new Error("--device-id is required");
  }
  const deviceId = args[deviceFlag + 1] ?? "";
  if (!uuidPattern.test(deviceId)) {
    throw new Error("--device-id must be a UUID");
  }

  const consumed = new Set(["--audit", "--cleanup", "--confirm", "--device-id", deviceId]);
  const unsupported = args.find((arg) => !consumed.has(arg));
  if (unsupported) throw new Error(`unsupported argument: ${unsupported}`);
  if (args.filter((arg) => arg === "--device-id").length !== 1) {
    throw new Error("--device-id must be provided once");
  }

  return { mode: audit ? "audit" : "cleanup", confirm, deviceId };
}

export async function runLegacyFallbackDuplicateCli(input: {
  args: string[];
  audit?: typeof auditLegacyFallbackDuplicates;
  cleanup?: typeof cleanupLegacyFallbackDuplicates;
  write?: (value: string) => void;
}): Promise<unknown> {
  const options = parseLegacyFallbackDuplicateCliArgs(input.args);
  const result = options.mode === "audit"
    ? await (input.audit ?? auditLegacyFallbackDuplicates)({ deviceId: options.deviceId })
    : await (input.cleanup ?? cleanupLegacyFallbackDuplicates)({
        deviceId: options.deviceId,
        confirm: options.confirm
      });
  (input.write ?? console.log)(JSON.stringify(result));
  return result;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLegacyFallbackDuplicateCli({ args: process.argv.slice(2) }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "legacy fallback duplicate maintenance failed");
    process.exitCode = 1;
  });
}
