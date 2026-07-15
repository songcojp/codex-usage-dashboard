import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("root agent script forwards CLI options to the workspace command", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts.agent,
    "npm --workspace @codex-usage-dashboard/agent run cli --"
  );
});
