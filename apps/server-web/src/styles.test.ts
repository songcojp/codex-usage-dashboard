import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const stylesPath = fileURLToPath(new URL("./styles.css", import.meta.url));

describe("dashboard metric styles", () => {
  test("keeps rolling digits horizontal inside metric cards", () => {
    const styles = readFileSync(stylesPath, "utf8");

    expect(styles).toContain(".metric-card span,");
    expect(styles).toContain(".metric-card .rolling-number");
    expect(styles).toContain(".metric-card .metric-digit-window");
    expect(styles).toContain(".metric-card .metric-digit-stack");
    expect(styles).toContain(".metric-card .metric-symbol");
  });

  test("defines the command center grid and exact responsive boundaries", () => {
    const styles = readFileSync(stylesPath, "utf8");

    expect(styles).toMatch(/\.dashboard-shell\s*\{[^}]*grid-template-columns:\s*200px minmax\(0,\s*1fr\)/s);
    expect(styles).toMatch(/\.overview-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(0,\s*2fr\)/s);
    expect(styles).toContain("@media (max-width: 1023px)");
    expect(styles).toContain("@media (max-width: 640px)");
    expect(styles).toContain("min-width: 320px");
  });

  test("keeps tables scrollable and removes geometry-shifting card hover", () => {
    const styles = readFileSync(stylesPath, "utf8");

    expect(styles).toMatch(/\.table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
    expect(styles).not.toMatch(/\.metric-card:hover[^}]*translateY/);
  });
});
