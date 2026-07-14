import { describe, expect, it } from "vitest";
import { toolSlugSchema } from "./schemas.js";

describe("tool slug schema", () => {
  it("accepts the three independent Codex types and the unknown-source fallback", () => {
    expect(toolSlugSchema.options).toEqual([
      "codex-cli",
      "codex-vscode-plugin",
      "codex-desktop",
      "other"
    ]);
    const removedName = ["anti", "gravity"].join("");
    expect(toolSlugSchema.safeParse(`${removedName}-ide`).success).toBe(false);
    expect(toolSlugSchema.safeParse(`codex-${removedName}-plugin`).success).toBe(false);
    expect(toolSlugSchema.safeParse("codex-vscode").success).toBe(false);
  });
});
