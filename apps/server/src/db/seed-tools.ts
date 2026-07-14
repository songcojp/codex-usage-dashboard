import type { TokenReportDb } from "./client.js";

import { tools } from "./schema.js";

export const initialTools: Array<typeof tools.$inferInsert> = [
  {
    slug: "codex-cli",
    displayName: "Codex CLI"
  },
  {
    slug: "codex-vscode-plugin",
    displayName: "Codex VS Code"
  },
  {
    slug: "codex-desktop",
    displayName: "Codex Desktop"
  },
  {
    slug: "other",
    displayName: "Other"
  }
];

export async function seedTools(db: TokenReportDb): Promise<void> {
  await db.insert(tools).values(initialTools).onConflictDoNothing({
    target: tools.slug
  });
}
