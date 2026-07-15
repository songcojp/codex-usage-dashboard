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

  test("generates correct options for token-ratio, cost-ratio, and app-ratio", () => {
    const points = [
      {
        day: "2026-05-30",
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 30,
        cacheReadTokens: 15,
        cacheWriteTokens: 5,
        costUsd: 1.0,
        inputCostUsd: 0.5,
        outputCostUsd: 0.3,
        cacheCostUsd: 0.2,
        eventCount: 1,
        toolUsages: [
          { toolSlug: "cli", toolName: "CLI", totalTokens: 60, costUsd: 0.6 },
          { toolSlug: "vscode", toolName: "VS Code", totalTokens: 40, costUsd: 0.4 }
        ]
      }
    ];

    // 1. token-ratio
    const tokenOption = createTrendChartOption(points, (key) => key, "en", "light", "daily", "token-ratio");
    expect(tokenOption.series).toHaveLength(3);
    // input = 50%, output = 30%, cache = (15+5)/100 = 20%
    expect(tokenOption.series[0]).toEqual(expect.objectContaining({ name: "Input ratio", data: [50] }));
    expect(tokenOption.series[1]).toEqual(expect.objectContaining({ name: "Output ratio", data: [30] }));
    expect(tokenOption.series[2]).toEqual(expect.objectContaining({ name: "Cache ratio", data: [20] }));

    // 2. cost-ratio
    const costOption = createTrendChartOption(points, (key) => key, "en", "light", "daily", "cost-ratio");
    expect(costOption.series).toHaveLength(3);
    // input = 0.5/1.0 = 50%, output = 0.3/1.0 = 30%, cache = 0.2/1.0 = 20%
    expect(costOption.series[0]).toEqual(expect.objectContaining({ name: "Input cost ratio", data: [50] }));
    expect(costOption.series[1]).toEqual(expect.objectContaining({ name: "Output cost ratio", data: [30] }));
    expect(costOption.series[2]).toEqual(expect.objectContaining({ name: "Cache cost ratio", data: [20] }));

    // 3. app-ratio
    const appOption = createTrendChartOption(points, (key) => key, "en", "light", "daily", "app-ratio");
    expect(appOption.series).toHaveLength(2);
    // CLI = 0.6 / 1.0 = 60%, VS Code = 0.4 / 1.0 = 40%
    expect(appOption.series[0].name).toBe("CLI");
    expect(appOption.series[0].data).toEqual([60]);
    expect(appOption.series[1].name).toBe("VS Code");
    expect(appOption.series[1].data).toEqual([40]);
  });
});
