import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { UsageSummary } from "../api.js";
import type { Translate } from "../dashboard-types.js";

type MetricsOverviewProps = {
  summary?: UsageSummary;
  initialLoading: boolean;
  t: Translate;
};

export function MetricsOverview({ summary, initialLoading, t }: MetricsOverviewProps) {
  const metrics = [
    { key: "total", label: t("Total tokens"), value: summary?.totalTokens, emphasis: "primary" },
    { key: "cache", label: t("Cache read"), value: summary?.cacheReadTokens },
    { key: "input", label: t("Input"), value: summary?.inputTokens },
    { key: "output", label: t("Output"), value: summary?.outputTokens },
    { key: "cost", label: t("Cost"), value: summary?.costUsd, currency: true }
  ];

  return (
    <section className="metrics-overview" aria-label="Token metrics">
      {metrics.map((metric) => (
        <MetricCard
          emphasis={metric.emphasis}
          initialLoading={initialLoading}
          key={metric.key}
          label={metric.label}
          value={metric.value}
          currency={metric.currency}
        />
      ))}
    </section>
  );
}

function MetricCard({
  emphasis,
  initialLoading,
  label,
  value,
  currency = false
}: {
  emphasis?: string;
  initialLoading: boolean;
  label: string;
  value?: number;
  currency?: boolean;
}) {
  const [animating, setAnimating] = useState(false);
  const previousValue = useRef<number | undefined>(undefined);
  const formattedValue = currency ? `$${(value ?? 0).toFixed(2)}` : (value ?? 0).toLocaleString();

  useEffect(() => {
    if (value === undefined) return;
    if (previousValue.current !== undefined && previousValue.current !== value) {
      setAnimating(true);
      const timeout = window.setTimeout(() => setAnimating(false), 620);
      previousValue.current = value;
      return () => window.clearTimeout(timeout);
    }
    previousValue.current = value;
  }, [value]);

  return (
    <article
      aria-label={`${label} metric`}
      className={emphasis === "primary" ? "metric-card metric-card-primary" : "metric-card"}
      data-emphasis={emphasis}
    >
      <span className="metric-label">{label}</span>
      {initialLoading ? (
        <span className="metric-skeleton" aria-hidden="true" />
      ) : (
        <strong className={animating ? "metric-value updating" : "metric-value"}>
          <span className="sr-only">{formattedValue}</span>
          <RollingMetricValue value={formattedValue} />
        </strong>
      )}
    </article>
  );
}

function RollingMetricValue({ value }: { value: string }) {
  return (
    <span className="rolling-number" aria-hidden="true">
      {[...value].map((character, index) =>
        /\d/.test(character) ? (
          <span
            className="metric-digit-window"
            key={`digit-${index}`}
            style={{ "--metric-digit": Number(character) } as CSSProperties}
          >
            <span className="metric-digit-stack">
              {"0123456789".split("").map((digit) => (
                <span className="metric-digit" key={digit}>
                  {digit}
                </span>
              ))}
            </span>
          </span>
        ) : (
          <span className="metric-symbol" key={`symbol-${index}`}>
            {character}
          </span>
        )
      )}
    </span>
  );
}
