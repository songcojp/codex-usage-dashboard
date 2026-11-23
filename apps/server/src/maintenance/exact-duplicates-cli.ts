import { pathToFileURL } from "node:url";

import {
  auditExactUsageDuplicates,
  cleanupExactUsageDuplicates
} from "./exact-duplicates.js";

export type ExactDuplicateCliOptions = {
  mode: "audit" | "cleanup";
  confirm: boolean;
};

export function parseExactDuplicateCliArgs(args: string[]): ExactDuplicateCliOptions {
  const known = new Set(["--audit", "--cleanup", "--confirm"]);
  const unsupported = args.find((arg) => !known.has(arg));
  if (unsupported) throw new Error(`unsupported argument: ${unsupported}`);

  const audit = args.includes("--audit");
  const cleanup = args.includes("--cleanup");
  if (Number(audit) + Number(cleanup) !== 1) {
    throw new Error("choose exactly one mode: --audit or --cleanup");
  }

  const confirm = args.includes("--confirm");
  if (cleanup && !confirm) throw new Error("cleanup mode requires --confirm");
  return { mode: audit ? "audit" : "cleanup", confirm };
}

export async function runExactDuplicateCli(input: {
  args: string[];
  audit?: typeof auditExactUsageDuplicates;
  cleanup?: typeof cleanupExactUsageDuplicates;
  write?: (value: string) => void;
}): Promise<unknown> {
  const options = parseExactDuplicateCliArgs(input.args);
  const result = options.mode === "audit"
    ? await (input.audit ?? auditExactUsageDuplicates)()
    : await (input.cleanup ?? cleanupExactUsageDuplicates)({ confirm: options.confirm });
  (input.write ?? console.log)(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runExactDuplicateCli({ args: process.argv.slice(2) }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "exact duplicate maintenance failed");
    process.exitCode = 1;
  });
}
