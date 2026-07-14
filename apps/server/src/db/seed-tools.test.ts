import { describe, expect, it } from "vitest";

import { initialTools } from "./seed-tools.js";

describe("initial tools", () => {
  it("contains the three independent Codex tools and Other", () => {
    expect(initialTools).toEqual([
      { slug: "codex-cli", displayName: "Codex CLI" },
      { slug: "codex-vscode-plugin", displayName: "Codex VS Code" },
      { slug: "codex-desktop", displayName: "Codex Desktop" },
      { slug: "other", displayName: "Other" }
    ]);
  });
});
