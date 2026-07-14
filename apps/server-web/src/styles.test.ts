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
});
