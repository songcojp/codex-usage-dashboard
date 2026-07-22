import { LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { type ECharts, init, use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectRatioResponse, TrendPoint } from "../api.js";
import type { Language, Theme, Translate } from "../dashboard-types.js";

use([GridComponent, LegendComponent, LineChart, PieChart, TooltipComponent, CanvasRenderer]);

type TrendMode = "daily" | "cumulative";
type TrendFilter =
  | "all"
  | "tokens"
  | "cost"
  | "tool-ratio"
  | "project-ratio"
  | "token-ratio"
  | "cost-ratio";

type TrendPanelProps = {
  points: TrendPoint[];
  projectRatios: ProjectRatioResponse;
  initialLoading: boolean;
  language: Language;
  theme: Theme;
  t: Translate;
  meta?: string;
};

export function TrendPanel({
  points,
  projectRatios,
  initialLoading,
  language,
  theme,
  t,
  meta
}: TrendPanelProps) {
  const [trendMode, setTrendMode] = useState<TrendMode>("daily");
  const [trendFilter, setTrendFilter] = useState<TrendFilter>("all");

  return (
    <div className="panel trend-panel">
      <div className="chart-header-row">
        <div className="panel-header">
          <div>
            <h2>{t(trendFilter === "project-ratio" ? "Project" : "Usage trend")}</h2>
            {meta && !(trendFilter === "project-ratio" && trendMode === "cumulative") ? (
              <p>{meta}</p>
            ) : null}
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
              {t(trendFilter === "project-ratio" ? "Total" : "Cumulative")}
            </button>
          </div>
          <div className="toggle-group" role="group" aria-label="Trend Filter">
            {(["all", "tokens", "cost", "tool-ratio", "project-ratio", "token-ratio", "cost-ratio"] as const).map((filter) => (
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
                    : filter === "tool-ratio"
                    ? "Tool"
                    : filter === "project-ratio"
                    ? "Project"
                    : filter === "token-ratio"
                    ? "Token"
                    : "Cost"
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
        projectRatios={projectRatios}
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
  trendFilter: TrendFilter = "all",
  projectRatios: ProjectRatioResponse = { daily: [], total: [] }
): any {
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
    const toolTotals: Record<string, { toolName: string; totalTokens: number; costUsd: number }> = {};

    processedPoints = points.map((point) => {
      total += point.totalTokens;
      input += point.inputTokens;
      output += point.outputTokens;
      cache += point.cacheReadTokens + point.cacheWriteTokens;
      cost += point.costUsd;
      inputCost += point.inputCostUsd ?? 0;
      outputCost += point.outputCostUsd ?? 0;
      cacheCost += point.cacheCostUsd ?? 0;

      for (const u of point.toolUsages || []) {
        if (!toolTotals[u.toolSlug]) {
          toolTotals[u.toolSlug] = { toolName: u.toolName, totalTokens: 0, costUsd: 0 };
        }
        toolTotals[u.toolSlug].totalTokens += u.totalTokens;
        toolTotals[u.toolSlug].costUsd += u.costUsd;
      }

      const cumToolUsages = Object.entries(toolTotals).map(([toolSlug, usage]) => ({
        toolSlug,
        toolName: usage.toolName,
        totalTokens: usage.totalTokens,
        costUsd: usage.costUsd
      }));

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

  if (trendFilter === "project-ratio" && trendMode === "cumulative") {
    return {
      backgroundColor: theme === "dark" ? "#0d1b2e" : "#ffffff",
      color: colors,
      tooltip: {
        trigger: "item",
        formatter: "{b}: {c} Token ({d}%)",
        backgroundColor: theme === "dark" ? "#0d213f" : "#ffffff",
        borderColor: axisLineColor,
        textStyle: { color: theme === "dark" ? "#f5f7fa" : "#0b1830" }
      },
      legend: {
        type: "scroll",
        top: 0,
        left: 0,
        right: 0,
        textStyle: { color: textColor }
      },
      series: [
        {
          name: t("Project"),
          type: "pie",
          radius: ["42%", "70%"],
          center: ["50%", "56%"],
          avoidLabelOverlap: true,
          itemStyle: {
            borderColor: theme === "dark" ? "#0d1b2e" : "#ffffff",
            borderWidth: 2
          },
          label: { color: textColor, formatter: "{b}\n{d}%" },
          data: projectRatios.total
            .filter((project) => project.totalTokens > 0)
            .map((project) => ({ name: project.projectName, value: project.totalTokens }))
        }
      ]
    };
  }

  let visibleSeries: any[] = [];
  const isRatio = trendFilter.endsWith("-ratio");
  let axisDays = processedPoints.map((point) => point.day);

  if (trendFilter === "project-ratio") {
    axisDays = projectRatios.daily.map((point) => point.day);
    const projectNames = new Map<string, string>();
    for (const point of projectRatios.daily) {
      for (const project of point.projects) {
        projectNames.set(project.projectKey, project.projectName);
      }
    }

    visibleSeries = [...projectNames].map(([projectKey, projectName], index) => {
      const values = projectRatios.daily.map((point) => {
        const totalTokens = point.projects.reduce((sum, project) => sum + project.totalTokens, 0);
        const project = point.projects.find((item) => item.projectKey === projectKey);
        return totalTokens > 0 && project
          ? Number(((project.totalTokens / totalTokens) * 100).toFixed(1))
          : 0;
      });
      return makeSeries(projectName, values, colors[index % colors.length]);
    });

    if (visibleSeries.length === 0) {
      visibleSeries = [makeSeries(t("No project usage"), axisDays.map(() => 0), colors[0])];
    }
  } else if (trendFilter === "token-ratio") {
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
      makeSeries(t("Input"), tokenRatioValues.input, colors[1]),
      makeSeries(t("Output"), tokenRatioValues.output, colors[2]),
      makeSeries(t("Cache"), tokenRatioValues.cache, colors[3])
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
      makeSeries(t("Input cost"), costRatioValues.input, colors[1]),
      makeSeries(t("Output cost"), costRatioValues.output, colors[2]),
      makeSeries(t("Cache cost"), costRatioValues.cache, colors[3])
    ];
  } else if (trendFilter === "tool-ratio") {
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
        const totalTokens = usages.reduce((sum, u) => sum + u.totalTokens, 0);
        return totalTokens > 0 && target
          ? Number(((target.totalTokens / totalTokens) * 100).toFixed(1))
          : 0;
      });
      const color = colors[idx % colors.length];
      return makeSeries(toolNames[toolSlug] || toolSlug, toolValues, color);
    });

    if (visibleSeries.length === 0) {
      visibleSeries = [makeSeries(t("No tools"), processedPoints.map(() => 0), colors[0])];
    }
  } else {
    const values = {
      total: processedPoints.map((point) => point.totalTokens),
      input: processedPoints.map((point) => point.inputTokens),
      output: processedPoints.map((point) => point.outputTokens),
      cache: processedPoints.map((point) => point.cacheReadTokens + point.cacheWriteTokens),
      cost: processedPoints.map((point) => point.costUsd),
      inputCost: processedPoints.map((point) => point.inputCostUsd ?? 0),
      cacheCost: processedPoints.map((point) => point.cacheCostUsd ?? 0),
      outputCost: processedPoints.map((point) => point.outputCostUsd ?? 0)
    };
    const series = [
      makeSeries(t("Total tokens"), values.total, colors[0], 3),
      makeSeries(t("Input"), values.input, colors[1]),
      makeSeries(t("Output"), values.output, colors[2]),
      makeSeries(t("Cache"), values.cache, colors[3]),
      makeSeries(t("Cost"), values.cost, colors[4], 2.5, formatCostUsd)
    ];
    const costSeries = [
      makeSeries(t("Input cost"), values.inputCost, colors[1], 2, formatCostUsd),
      makeSeries(t("Cache cost"), values.cacheCost, colors[3], 2, formatCostUsd),
      makeSeries(t("Output cost"), values.outputCost, colors[2], 2, formatCostUsd)
    ];
    visibleSeries = trendFilter === "cost" ? costSeries : trendFilter === "tokens" ? series.slice(0, 4) : series;
  }

  const dailyTokenPercentageTooltipFormatter = trendMode === "daily" && (trendFilter === "tokens" || trendFilter === "all")
    ? createDailyTokenPercentageTooltipFormatter(processedPoints, t, language)
    : undefined;

  return {
    backgroundColor: theme === "dark" ? "#0d1b2e" : "#ffffff",
    color: visibleSeries.map((item) => item.itemStyle.color),
    grid: { top: 40, right: 18, bottom: 32, left: 58 },
    tooltip: {
      trigger: "axis",
      backgroundColor: theme === "dark" ? "#0d213f" : "#ffffff",
      borderColor: axisLineColor,
      textStyle: { color: theme === "dark" ? "#f5f7fa" : "#0b1830" },
      ...(dailyTokenPercentageTooltipFormatter
        ? { formatter: dailyTokenPercentageTooltipFormatter }
        : {
            valueFormatter: isRatio
              ? (value: number | string) => `${value}%`
              : trendFilter === "cost"
              ? formatCostUsd
              : undefined
          })
    },
    legend: { top: 0, right: 0, textStyle: { color: textColor } },
    xAxis: {
      type: "category",
      data: axisDays.map(formatUtcDateLabel),
      boundaryGap: false,
      axisLabel: { color: textColor },
      axisLine: { lineStyle: { color: axisLineColor } }
    },
    yAxis: {
      type: "value",
      max: isRatio ? 100 : undefined,
      axisLabel: {
        color: textColor,
        formatter: (value: number) => isRatio
          ? `${value}%`
          : trendFilter === "cost"
          ? formatCostUsd(value)
          : compactNumber(value, language)
      },
      splitLine: { lineStyle: { color: splitLineColor } }
    },
    series: visibleSeries
  };
}

function makeSeries(
  name: string,
  data: number[],
  color: string,
  width = 2,
  valueFormatter?: (value: number | string) => string
) {
  return {
    name,
    type: "line",
    smooth: true,
    data,
    symbolSize: 5,
    ...(valueFormatter ? { tooltip: { valueFormatter } } : {}),
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

function formatCostUsd(value: number | string): string {
  return `$${Number(value).toFixed(2)}`;
}

type AxisTooltipParam = {
  axisValueLabel?: string;
  data?: number | string;
  dataIndex?: number;
  marker?: string;
  name?: string;
  seriesName?: string;
  value?: number | string;
};

function createDailyTokenPercentageTooltipFormatter(points: TrendPoint[], t: Translate, language: Language) {
  const inputName = t("Input");
  const outputName = t("Output");
  const cacheName = t("Cache");
  const costName = t("Cost");
  const tokenSeriesNames = new Set([inputName, outputName, cacheName]);

  return (params: AxisTooltipParam | AxisTooltipParam[]) => {
    const items = Array.isArray(params) ? params : [params];
    const dataIndex = Number(items[0]?.dataIndex ?? 0);
    const point = points[dataIndex];
    const tokenTotal = point
      ? point.inputTokens + point.outputTokens + point.cacheReadTokens + point.cacheWriteTokens
      : 0;
    const percentages: Record<string, number> = point && tokenTotal > 0
      ? {
          [inputName]: point.inputTokens / tokenTotal,
          [outputName]: point.outputTokens / tokenTotal,
          [cacheName]: (point.cacheReadTokens + point.cacheWriteTokens) / tokenTotal
        }
      : {};

    const title = items[0]?.axisValueLabel ?? items[0]?.name ?? (point ? formatUtcDateLabel(point.day) : "");
    const rows = [`<strong>${escapeHtml(String(title))}</strong>`];

    for (const item of items) {
      const seriesName = item.seriesName ?? "";
      const rawValue = item.value ?? item.data ?? 0;
      const formattedValue = seriesName === costName
        ? formatCostUsd(rawValue)
        : formatTokenValue(rawValue, language);
      const percentage = tokenSeriesNames.has(seriesName) && percentages[seriesName] !== undefined
        ? ` (${formatPercent(percentages[seriesName])})`
        : "";

      rows.push(`${item.marker ?? ""}${escapeHtml(seriesName)}: ${escapeHtml(formattedValue)}${percentage}`);
    }

    return rows.join("<br/>");
  };
}

function formatTokenValue(value: number | string, language: Language): string {
  const locales: Record<Language, string> = { zh: "zh-CN", ja: "ja-JP", en: "en-US", ko: "ko-KR" };
  return Number(value).toLocaleString(locales[language], { maximumFractionDigits: 0 });
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function TrendChart({
  points,
  projectRatios,
  initialLoading,
  language,
  t,
  theme,
  trendMode,
  trendFilter
}: {
  points: TrendPoint[];
  projectRatios: ProjectRatioResponse;
  initialLoading: boolean;
  language: Language;
  t: Translate;
  theme: Theme;
  trendMode: TrendMode;
  trendFilter: TrendFilter;
}) {
  const chartElement = useRef<HTMLDivElement | null>(null);
  const hasData = trendFilter === "project-ratio"
    ? trendMode === "daily"
      ? projectRatios.daily.length > 0
      : projectRatios.total.length > 0
    : points.length > 0;
  const chartOption = useMemo(
    () => createTrendChartOption(points, t, language, theme, trendMode, trendFilter, projectRatios),
    [language, points, projectRatios, t, theme, trendMode, trendFilter]
  );

  useEffect(() => {
    if (!chartElement.current || initialLoading || !hasData) return;
    let chart: ECharts | null = init(chartElement.current);
    chart.setOption(chartOption);
    const handleResize = () => chart?.resize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart?.dispose();
      chart = null;
    };
  }, [chartOption, hasData, initialLoading]);

  if (initialLoading) return <div className="chart-empty chart-skeleton">{t("Loading trend data...")}</div>;
  if (!hasData) {
    return (
      <div className="chart-empty">
        {t(trendFilter === "project-ratio" ? "No project usage" : "No trend data for this range.")}
      </div>
    );
  }
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
