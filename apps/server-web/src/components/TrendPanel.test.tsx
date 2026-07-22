// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { translations } from "../locales/index.js";
import { createTrendChartOption, TrendPanel } from "./TrendPanel.js";

const emptyProjectRatios = { daily: [], total: [] };
const identity = (key: string) => key;
const translateEn = (key: string) => translations.en[key] ?? key;

describe("createTrendChartOption", () => {
  test("filters the chart to input, cache, and output costs without changing its source points", () => {
    const points = [
      {
        day: "2026-05-30",
        totalTokens: 100,
        inputTokens: 40,
        outputTokens: 30,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        costUsd: 0.125,
        inputCostUsd: 0.04,
        cacheCostUsd: 0.025,
        outputCostUsd: 0.06,
        eventCount: 1
      }
    ];
    const option = createTrendChartOption(points, (key) => key, "en", "light", "daily", "cost");
    expect(option.series).toHaveLength(3);
    expect(option.series[0]).toEqual(expect.objectContaining({ name: "Input cost", data: [0.04] }));
    expect(option.series[1]).toEqual(expect.objectContaining({ name: "Cache cost", data: [0.025] }));
    expect(option.series[2]).toEqual(expect.objectContaining({ name: "Output cost", data: [0.06] }));
    expect(option.tooltip.valueFormatter(0.025)).toBe("$0.03");
    expect(option.yAxis.axisLabel.formatter(0.025)).toBe("$0.03");
    expect(option.series[1].tooltip.valueFormatter(0.025)).toBe("$0.03");
    expect(points[0].cacheWriteTokens).toBe(10);
  });

  test("formats the total cost series to two decimals without formatting token series as currency", () => {
    const points = [
      {
        day: "2026-05-30",
        totalTokens: 100,
        inputTokens: 40,
        outputTokens: 30,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        costUsd: 0.125,
        inputCostUsd: 0.04,
        cacheCostUsd: 0.025,
        outputCostUsd: 0.06,
        eventCount: 1
      }
    ];

    const option = createTrendChartOption(points, identity, "en", "light", "daily", "all");

    expect(option.series[0].tooltip).toBeUndefined();
    expect(option.series[4].data).toEqual([0.125]);
    expect(option.series[4].tooltip.valueFormatter(0.125)).toBe("$0.13");
  });

  test("adds daily token category shares to the token tooltip", () => {
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

    const option = createTrendChartOption(points, identity, "en", "light", "daily", "tokens");
    const tooltip = option.tooltip.formatter([
      { axisValueLabel: "05-30", dataIndex: 0, marker: "", seriesName: "Total tokens", value: 100 },
      { axisValueLabel: "05-30", dataIndex: 0, marker: "", seriesName: "Input", value: 40 },
      { axisValueLabel: "05-30", dataIndex: 0, marker: "", seriesName: "Output", value: 30 },
      { axisValueLabel: "05-30", dataIndex: 0, marker: "", seriesName: "Cache", value: 30 }
    ]);

    expect(tooltip).toContain("Total tokens: 100");
    expect(tooltip).toContain("Input: 40 (40.0%)");
    expect(tooltip).toContain("Output: 30 (30.0%)");
    expect(tooltip).toContain("Cache: 30 (30.0%)");
  });

  test("keeps cumulative token tooltips numeric-only", () => {
    const option = createTrendChartOption(
      [
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
      ],
      identity,
      "en",
      "light",
      "cumulative",
      "tokens"
    );

    expect(option.tooltip.formatter).toBeUndefined();
    expect(option.tooltip.valueFormatter).toBeUndefined();
  });

  test("accumulates input, cache, and output cost series independently", () => {
    const points = [
      {
        day: "2026-05-30",
        totalTokens: 100,
        inputTokens: 40,
        outputTokens: 30,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        costUsd: 6,
        inputCostUsd: 1,
        cacheCostUsd: 2,
        outputCostUsd: 3,
        eventCount: 1
      },
      {
        day: "2026-05-31",
        totalTokens: 200,
        inputTokens: 80,
        outputTokens: 60,
        cacheReadTokens: 40,
        cacheWriteTokens: 20,
        costUsd: 15,
        inputCostUsd: 4,
        cacheCostUsd: 5,
        outputCostUsd: 6,
        eventCount: 1
      }
    ];

    const option = createTrendChartOption(points, identity, "en", "light", "cumulative", "cost");

    expect(option.series[0]).toEqual(expect.objectContaining({ name: "Input cost", data: [1, 5] }));
    expect(option.series[1]).toEqual(expect.objectContaining({ name: "Cache cost", data: [2, 7] }));
    expect(option.series[2]).toEqual(expect.objectContaining({ name: "Output cost", data: [3, 9] }));
  });

  test("generates correct options for token-ratio and cost-ratio", () => {
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

  });

  test("calculates tool share from tokens instead of cost", () => {
    const points = [
      {
        day: "2026-07-15",
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 30,
        cacheReadTokens: 15,
        cacheWriteTokens: 5,
        costUsd: 10,
        eventCount: 1,
        toolUsages: [
          { toolSlug: "cli", toolName: "CLI", totalTokens: 80, costUsd: 1 },
          { toolSlug: "vscode", toolName: "VS Code", totalTokens: 20, costUsd: 9 }
        ]
      }
    ];

    const option = createTrendChartOption(
      points,
      identity,
      "en",
      "light",
      "daily",
      "tool-ratio",
      emptyProjectRatios
    );

    expect(option.series[0]).toEqual(expect.objectContaining({ name: "CLI", data: [80] }));
    expect(option.series[1]).toEqual(expect.objectContaining({ name: "VS Code", data: [20] }));
  });

  test("carries earlier tool totals across cumulative days", () => {
    const option = createTrendChartOption(
      [
        {
          day: "2026-07-14",
          totalTokens: 100,
          inputTokens: 50,
          outputTokens: 30,
          cacheReadTokens: 15,
          cacheWriteTokens: 5,
          costUsd: 1,
          eventCount: 1,
          toolUsages: [
            { toolSlug: "cli", toolName: "CLI", totalTokens: 80, costUsd: 0.8 },
            { toolSlug: "vscode", toolName: "VS Code", totalTokens: 20, costUsd: 0.2 }
          ]
        },
        {
          day: "2026-07-15",
          totalTokens: 100,
          inputTokens: 50,
          outputTokens: 30,
          cacheReadTokens: 15,
          cacheWriteTokens: 5,
          costUsd: 1,
          eventCount: 1,
          toolUsages: [
            { toolSlug: "vscode", toolName: "VS Code", totalTokens: 100, costUsd: 1 }
          ]
        }
      ],
      identity,
      "en",
      "light",
      "cumulative",
      "tool-ratio",
      emptyProjectRatios
    );

    expect(option.series[0]).toEqual(expect.objectContaining({ name: "CLI", data: [80, 40] }));
    expect(option.series[1]).toEqual(
      expect.objectContaining({ name: "VS Code", data: [20, 60] })
    );
  });

  test("calculates daily project shares and fills missing project days with zero", () => {
    const projectRatios = {
      daily: [
        {
          day: "2026-07-14",
          projects: [
            { projectKey: "repo:a", projectName: "Project A", totalTokens: 75 },
            { projectKey: "repo:b", projectName: "Project B", totalTokens: 25 }
          ]
        },
        {
          day: "2026-07-15",
          projects: [{ projectKey: "repo:b", projectName: "Project B", totalTokens: 50 }]
        }
      ],
      total: []
    };
    const source = structuredClone(projectRatios);

    const option = createTrendChartOption(
      [],
      identity,
      "en",
      "light",
      "daily",
      "project-ratio",
      projectRatios
    );

    expect(option.xAxis.data).toEqual(["07-14", "07-15"]);
    expect(option.series).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Project A", type: "line", data: [75, 0] }),
        expect.objectContaining({ name: "Project B", type: "line", data: [25, 100] })
      ])
    );
    expect(projectRatios).toEqual(source);
  });

  test("renders all-time project shares as a pie using raw token totals", () => {
    const projectRatios = {
      daily: [],
      total: [
        { projectKey: "repo:a", projectName: "Project A", totalTokens: 90 },
        { projectKey: "repo:b", projectName: "Project B", totalTokens: 10 }
      ]
    };

    const option = createTrendChartOption(
      [],
      identity,
      "en",
      "dark",
      "cumulative",
      "project-ratio",
      projectRatios
    );

    expect(option.series).toEqual([
      expect.objectContaining({
        type: "pie",
        data: [
          { name: "Project A", value: 90 },
          { name: "Project B", value: 10 }
        ]
      })
    ]);
    expect(option.legend.type).toBe("scroll");
    expect(option.xAxis).toBeUndefined();
    expect(option.yAxis).toBeUndefined();
  });
});

describe("TrendPanel controls", () => {
  test("uses share terminology in English ratio controls", () => {
    expect(translations.en["Tool ratio"]).toBe("Tool share");
    expect(translations.en["Project ratio"]).toBe("Project share");
    expect(translations.en["Token ratio"]).toBe("Token share");
    expect(translations.en["Cost ratio"]).toBe("Cost share");
    expect(translations.en["Input ratio"]).toBe("Input share");
    expect(translations.en["Output ratio"]).toBe("Output share");
    expect(translations.en["Cache ratio"]).toBe("Cache share");
    expect(translations.en["Input cost ratio"]).toBe("Input cost share");
    expect(translations.en["Output cost ratio"]).toBe("Output cost share");
    expect(translations.en["Cache cost ratio"]).toBe("Cache cost share");
  });

  test("uses tool and project terminology in Chinese", () => {
    expect(translations.zh["Tool ratio"]).toBe("工具占比");
    expect(translations.zh["Project ratio"]).toBe("项目占比");
    expect(translations.zh.Total).toBe("总量");
    expect(translations.zh["No tools"]).toBe("无工具数据");
    expect(translations.zh["No project usage"]).toBe("无项目用量数据");
    expect(translations.zh["Input cost"]).toBe("输入成本");
    expect(translations.zh["Cache cost"]).toBe("缓存成本");
    expect(translations.zh["Output cost"]).toBe("输出成本");
  });

  test("labels project total mode separately from cumulative trends", () => {
    render(
      <TrendPanel
        points={[]}
        projectRatios={emptyProjectRatios}
        initialLoading={false}
        language="en"
        meta="2026-07-01 to 2026-07-15 (UTC)"
        theme="light"
        t={translateEn}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Project share" }));
    expect(screen.getByRole("heading", { name: "Project share" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Total" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "App ratio" })).toBeNull();
    expect(screen.getByText("2026-07-01 to 2026-07-15 (UTC)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Total" }));
    expect(screen.queryByText("2026-07-01 to 2026-07-15 (UTC)")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Tool share" }));
    expect(screen.getByRole("button", { name: "Cumulative" })).toBeTruthy();
  });
});
