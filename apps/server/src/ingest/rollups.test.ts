import { describe, expect, it } from "vitest";
import { addRollupMetrics, calculateEventCostUsd, dayFromTimestamp } from "./service.js";

describe("addRollupMetrics", () => {
  it("adds token metrics from an event to the current rollup", () => {
    expect(
      addRollupMetrics(
        {
          totalTokens: 100,
          inputTokens: 40,
          outputTokens: 30,
          cacheReadTokens: 20,
          cacheWriteTokens: 10
        },
        {
          totalTokens: 17,
          inputTokens: 8,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 1
        }
      )
    ).toEqual({
      totalTokens: 117,
      inputTokens: 48,
      outputTokens: 35,
      cacheReadTokens: 23,
      cacheWriteTokens: 11
    });
  });
});

describe("dayFromTimestamp", () => {
  it("assigns rollup days using the +09:00 reporting timezone", () => {
    expect(dayFromTimestamp("2026-05-30T14:59:59.999Z")).toBe("2026-05-30");
    expect(dayFromTimestamp("2026-05-30T15:00:00.000Z")).toBe("2026-05-31");
  });
});

describe("calculateEventCostUsd", () => {
  it("calculates cost from four token classes with per-million USD rates", () => {
    expect(
      calculateEventCostUsd(
        {
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cacheReadTokens: 250_000,
          cacheWriteTokens: 125_000
        },
        {
          inputCostPerMillionUsd: 2,
          outputCostPerMillionUsd: 10,
          cacheReadCostPerMillionUsd: 0.5,
          cacheWriteCostPerMillionUsd: 1
        }
      )
    ).toBe(7.25);
  });

  it("uses zero cost when no model price is configured", () => {
    expect(
      calculateEventCostUsd(
        {
          inputTokens: 100,
          outputTokens: 100,
          cacheReadTokens: 100,
          cacheWriteTokens: 100
        },
        null
      )
    ).toBe(0);
  });
});
