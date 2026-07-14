// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { DashboardIcon } from "./DashboardIcons.js";

describe("DashboardIcon", () => {
  test("renders a decorative currentColor icon", () => {
    const { container } = render(<DashboardIcon name="dashboard" />);
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
  });
});
