// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { MetricsOverview } from "./MetricsOverview.js";

const summary = {
  totalTokens: 100,
  inputTokens: 40,
  outputTokens: 30,
  cacheReadTokens: 20,
  cacheWriteTokens: 10,
  costUsd: 0.125,
  eventCount: 1
};

describe("MetricsOverview", () => {
  afterEach(cleanup);

  test("emphasizes total tokens and renders the four supporting metrics", () => {
    render(<MetricsOverview summary={summary} initialLoading={false} t={(key) => key} />);
    expect(screen.getByLabelText("Total tokens metric").getAttribute("data-emphasis")).toBe("primary");
    expect(screen.getAllByRole("article")).toHaveLength(5);
  });

  test("renders size-stable metric skeletons during initial loading", () => {
    const { container } = render(<MetricsOverview initialLoading t={(key) => key} />);
    expect(container.querySelectorAll(".metric-skeleton")).toHaveLength(5);
  });
});
