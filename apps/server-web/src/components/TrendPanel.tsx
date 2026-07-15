import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { type ECharts, init, use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TrendPoint } from "../api.js";
import type { Language, Theme, Translate } from "../dashboard-types.js";

use([GridComponent, LegendComponent, LineChart, TooltipComponent, CanvasRenderer]);

type TrendMode = "daily" | "cumulative";
type TrendFilter = "all" | "tokens" | "cost" | "app-ratio" | "token-ratio" | "cost-ratio";

type TrendPanelProps = {
  points: TrendPoint[];
  initialLoading: boolean;
  language: Language;
  theme: Theme;
  t: Translate;
  meta?: string;
};

export function TrendPanel({ points, initialLoading, language, theme, t, meta }: TrendPanelProps) {
  const [trendMode, setTrendMode] = useState<TrendMode>("daily");
  const [trendFilter, setTrendFilter] = useState<TrendFilter>("all");

  return (
    <div className="panel trend-panel">
      <div className="chart-header-row">
        <div className="panel-header">
          <div>
            <h2>{t("Usage trend")}</h2>
            {meta ? <p>{meta}</p> : null}
          </div>
        </div>
        <div className="chart-controls">
          <div className="toggle-group" role="group" aria-label="Trend Mode">
            <button
              className={trendMode === "daily" ? "toggle-btn active" : "toggle-btn"}
              onClick={() => setTrendMode("daily")}
              type="button"
            >
              {t("Daily")}
            </button>
            <button
              className={trendMode === "cumulative" ? "toggle-btn active" : "toggle-btn"}
              onClick={() => setTrendMode("cumulative")}
              type="button"
            >
              {t("Cumulative")}
            </button>
          </div>
          <div className="toggle-group" role="group" aria-label="Trend Filter">
            {(["all", "tokens", "cost", "app-ratio", "token-ratio", "cost-ratio"] as const).map((filter) => (
              <button
                className={trendFilter === filter ? "toggle-btn active" : "toggle-btn"}
                key={filter}
                onClick={() => setTrendFilter(filter)}
                type="button"
              >
                {t(
                  filter === "all"
                    ? "All"
                    : filter === "tokens"
                    ? "Tokens"
                    : filter === "cost"
                    ? "Cost"
                    : filter === "app-ratio"
                    ? "App ratio"
                    : filter === "token-ratio"
                    ? "Token ratio"
                    : "Cost ratio"
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
      <TrendChart
        initialLoading={initialLoading}
        language={language}
        points={points}
        t={t}
        theme={theme}
        trendFilter={trendFilter}
        trendMode={trendMode}
      />
    </div>
  );
}

export function createTrendChartOption(
  points: TrendPoint[],
  t: Translate,
  language: Language,
  theme: Theme = "light",
  trendMode: TrendMode = "daily",
  trendFilter: TrendFilter = "all"
) {
  let processedPoints = [...points];
  if (trendMode === "cumulative") {
    let total = 0;
    let input = 0;
    let output = 0;
    let cache = 0;
    let cost = 0;
    let inputCost = 0;
    let outputCost = 0;
    let cacheCost = 0;
    const toolTotals: Record<string, { totalTokens: number; costUsd: number }> = {};

    processedPoints = points.map((point) => {
      total += point.totalTokens;
      input += point.inputTokens;
      output += point.outputTokens;
      cache += point.cacheReadTokens + point.cacheWriteTokens;
      cost += point.costUsd;
      inputCost += point.inputCostUsd ?? 0;
      outputCost += point.outputCostUsd ?? 0;
      cacheCost += point.cacheCostUsd ?? 0;

      const cumToolUsages = (point.toolUsages || []).map((u) => {
        if (!toolTotals[u.toolSlug]) {
          toolTotals[u.toolSlug] = { totalTokens: 0, costUsd: 0 };
        }
        toolTotals[u.toolSlug].totalTokens += u.totalTokens;
        toolTotals[u.toolSlug].costUsd += u.costUsd;
        return {
          ...u,
          totalTokens: toolTotals[u.toolSlug].totalTokens,
          costUsd: toolTotals[u.toolSlug].costUsd
        };
      });

      return {
        ...point,
        totalTokens: total,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cache,
        cacheWriteTokens: 0,
        costUsd: cost,
        inputCostUsd: inputCost,
        outputCostUsd: outputCost,
        cacheCostUsd: cacheCost,
        toolUsages: cumToolUsages
      };
    });
  }

  const colors = theme === "dark"
    ? ["#4f86ff", "#2dd4bf", "#fb923c", "#22d3ee", "#c084fc", "#a855f7", "#ec4899", "#10b981", "#f59e0b"]
    : ["#1760ff", "#0f766e", "#b45309", "#0891b2", "#7c3aed", "#7e22ce", "#db2777", "#059669", "#d97706"];
  const textColor = theme === "dark" ? "#9eacc0" : "#526077";
  const splitLineColor = theme === "dark" ? "#243754" : "#e8edf3";
  const axisLineColor = theme === "dark" ? "#354965" : "#d9e1eb";

  let visibleSeries: any[] = [];
  const isRatio = trendFilter.endsWith("-ratio");

  if (trendFilter === "token-ratio") {
    const tokenRatioValues = {
      input: processedPoints.map((point) => {
        const total = point.inputTokens + point.outputTokens + point.cacheReadTokens + point.cacheWriteTokens;
        return total > 0 ? Number(((point.inputTokens / total) * 100).toFixed(1)) : 0;
      }),
      output: processedPoints.map((point) => {
        const total = point.inputTokens + point.outputTokens + point.cacheReadTokens + point.cacheWriteTokens;
        return total > 0 ? Number(((point.outputTokens / total) * 100).toFixed(1)) : 0;
      }),
      cache: processedPoints.map((point) => {
        const total = point.inputTokens + point.outputTokens + point.cacheReadTokens + point.cacheWriteTokens;
        const cacheVal = point.cacheReadTokens + point.cacheWriteTokens;
        return total > 0 ? Number(((cacheVal / total) * 100).toFixed(1)) : 0;
      })
    };
    visibleSeries = [
      makeSeries(t("Input ratio"), tokenRatioValues.input, colors[1]),
      makeSeries(t("Output ratio"), tokenRatioValues.output, colors[2]),
      makeSeries(t("Cache ratio"), tokenRatioValues.cache, colors[3])
    ];
  } else if (trendFilter === "cost-ratio") {
    const costRatioValues = {
      input: processedPoints.map((point) => {
        const inputC = point.inputCostUsd ?? 0;
        const outputC = point.outputCostUsd ?? 0;
        const cacheC = point.cacheCostUsd ?? 0;
        const total = inputC + outputC + cacheC;
        return total > 0 ? Number(((inputC / total) * 100).toFixed(1)) : 0;
      }),
      output: processedPoints.map((point) => {
        const inputC = point.inputCostUsd ?? 0;
        const outputC = point.outputCostUsd ?? 0;
        const cacheC = point.cacheCostUsd ?? 0;
        const total = inputC + outputC + cacheC;
        return total > 0 ? Number(((outputC / total) * 100).toFixed(1)) : 0;
      }),
      cache: processedPoints.map((point) => {
        const inputC = point.inputCostUsd ?? 0;
        const outputC = point.outputCostUsd ?? 0;
        const cacheC = point.cacheCostUsd ?? 0;
        const total = inputC + outputC + cacheC;
        return total > 0 ? Number(((cacheC / total) * 100).toFixed(1)) : 0;
      })
    };
    visibleSeries = [
      makeSeries(t("Input cost ratio"), costRatioValues.input, colors[1]),
      makeSeries(t("Output cost ratio"), costRatioValues.output, colors[2]),
      makeSeries(t("Cache cost ratio"), costRatioValues.cache, colors[3])
    ];
  } else if (trendFilter === "app-ratio") {
    const allTools = Array.from(
      new Set(processedPoints.flatMap((point) => (point.toolUsages || []).map((u) => u.toolSlug)))
    ).sort();

    const toolNames: Record<string, string> = {};
    for (const point of processedPoints) {
      for (const usage of point.toolUsages || []) {
        toolNames[usage.toolSlug] = usage.toolName;
      }
    }

    visibleSeries = allTools.map((toolSlug, idx) => {
      const toolValues = processedPoints.map((point) => {
        const usages = point.toolUsages || [];
        const target = usages.find((u) => u.toolSlug === toolSlug);
        const totalCost = usages.reduce((sum, u) => sum + u.costUsd, 0);
        return totalCost > 0 && target ? Number(((target.costUsd / totalCost) * 100).toFixed(1)) : 0;
      });
      const color = colors[idx % colors.length];
      return makeSeries(toolNames[toolSlug] || toolSlug, toolValues, color);
    });

    if (visibleSeries.length === 0) {
      visibleSeries = [makeSeries(t("No applications"), processedPoints.map(() => 0), colors[0])];
    }
  } else {
    const values = {
      total: processedPoints.map((point) => point.totalTokens),
      input: processedPoints.map((point) => point.inputTokens),
      output: processedPoints.map((point) => point.outputTokens),
      cache: processedPoints.map((point) => point.cacheReadTokens + point.cacheWriteTokens),
      cost: processedPoints.map((point) => point.costUsd)
    };
    const series = [
      makeSeries(t("Total tokens"), values.total, colors[0], 3),
      makeSeries(t("Input"), values.input, colors[1]),
      makeSeries(t("Output"), values.output, colors[2]),
      makeSeries(t("Cache"), values.cache, colors[3]),
      makeSeries(t("Cost"), values.cost, colors[4], 2.5)
    ];
    visibleSeries = trendFilter === "cost" ? [series[4]] : trendFilter === "tokens" ? series.slice(0, 4) : series;
  }

  return {
    backgroundColor: theme === "dark" ? "#0d1b2e" : "#ffffff",
    color: visibleSeries.map((item) => item.itemStyle.color),
    grid: { top: 40, right: 18, bottom: 32, left: 58 },
    tooltip: {
      trigger: "axis",
      backgroundColor: theme === "dark" ? "#0d213f" : "#ffffff",
      borderColor: axisLineColor,
      textStyle: { color: theme === "dark" ? "#f5f7fa" : "#0b1830" },
      valueFormatter: isRatio ? (value: any) => `${value}%` : undefined
    },
    legend: { top: 0, right: 0, textStyle: { color: textColor } },
    xAxis: {
      type: "category",
      data: processedPoints.map((point) => formatUtcDateLabel(point.day)),
      boundaryGap: false,
      axisLabel: { color: textColor },
      axisLine: { lineStyle: { color: axisLineColor } }
    },
    yAxis: {
      type: "value",
      max: isRatio ? 100 : undefined,
      axisLabel: {
        color: textColor,
        formatter: (value: number) => isRatio ? `${value}%` : compactNumber(value, language)
      },
      splitLine: { lineStyle: { color: splitLineColor } }
    },
    series: visibleSeries
  };
}

function makeSeries(name: string, data: number[], color: string, width = 2) {
  return {
    name,
    type: "line",
    smooth: true,
    data,
    symbolSize: 5,
    itemStyle: { color },
    lineStyle: { width },
    areaStyle: {
      color: {
        type: "linear",
        x: 0,
        y: 0,
        x2: 0,
        y2: 1,
        colorStops: [
          { offset: 0, color: withAlpha(color, "24") },
          { offset: 1, color: withAlpha(color, "00") }
        ]
      }
    }
  };
}

function TrendChart({
  points,
  initialLoading,
  language,
  t,
  theme,
  trendMode,
  trendFilter
}: {
  points: TrendPoint[];
  initialLoading: boolean;
  language: Language;
  t: Translate;
  theme: Theme;
  trendMode: TrendMode;
  trendFilter: TrendFilter;
}) {
  const chartElement = useRef<HTMLDivElement | null>(null);
  const chartOption = useMemo(
    () => createTrendChartOption(points, t, language, theme, trendMode, trendFilter),
    [language, points, t, theme, trendMode, trendFilter]
  );

  useEffect(() => {
    if (!chartElement.current || initialLoading || points.length === 0) return;
    let chart: ECharts | null = init(chartElement.current);
    chart.setOption(chartOption);
    const handleResize = () => chart?.resize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart?.dispose();
      chart = null;
    };
  }, [chartOption, initialLoading, points.length]);

  if (initialLoading) return <div className="chart-empty chart-skeleton">{t("Loading trend data...")}</div>;
  if (points.length === 0) return <div className="chart-empty">{t("No trend data for this range.")}</div>;
  return <div className="chart-surface" ref={chartElement} role="img" aria-label={t("Token usage trend chart")} />;
}

function formatUtcDateLabel(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function compactNumber(value: number, language: Language): string {
  const locales: Record<Language, string> = { zh: "zh-CN", ja: "ja-JP", en: "en-US", ko: "ko-KR" };
  return Intl.NumberFormat(locales[language], { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function withAlpha(color: string, alpha: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : color;
}
