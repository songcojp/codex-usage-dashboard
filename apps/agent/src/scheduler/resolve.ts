import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const buildInstruction =
  "run npm --workspace @codex-usage-dashboard/agent run build before installing scheduler";

export function resolveSchedulerScriptPath(scriptPath: string): string {
  const scriptFile = basename(scriptPath);
  const scriptDir = basename(dirname(scriptPath));

  if (scriptDir !== "src" || scriptFile !== "cli.ts") {
    return scriptPath;
  }

  const packageRoot = dirname(dirname(scriptPath));
  const distCliPath = join(packageRoot, "dist", "cli.js");

  if (!existsSync(distCliPath)) {
    throw new Error(
      `Cannot install scheduler from TypeScript source path ${scriptPath}; ${buildInstruction}.`
    );
  }

  return distCliPath;
}
