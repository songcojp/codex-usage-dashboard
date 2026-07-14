import { describe, expect, test } from "vitest";
import { createTrendChartOption } from "./TrendPanel.js";

describe("createTrendChartOption", () => {
  test("filters the chart to cost without changing its source points", () => {
    const points = [
      {
        day: "2026-05-30",
        totalTokens: 100,
        inputTokens: 40,
        outputTokens: 30,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        costUsd: 0.125,
        eventCount: 1
      }
    ];
    const option = createTrendChartOption(points, (key) => key, "en", "light", "daily", "cost");
    expect(option.series).toHaveLength(1);
    expect(option.series[0]).toEqual(expect.objectContaining({ name: "Cost", data: [0.125] }));
    expect(points[0].cacheWriteTokens).toBe(10);
  });
});
