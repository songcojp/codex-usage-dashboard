import { describe, expect, it } from "vitest";
import { RetryBackoff } from "./retry.js";

describe("retry backoff", () => {
  it("doubles from 30 seconds to a 30 minute cap and resets", () => {
    const retry = new RetryBackoff();
    expect(retry.nextDelay()).toBe(30_000);
    expect(retry.nextDelay()).toBe(60_000);
    for (let index = 0; index < 10; index += 1) retry.nextDelay();
    expect(retry.nextDelay()).toBe(30 * 60_000);
    retry.reset();
    expect(retry.nextDelay()).toBe(30_000);
  });

  it("uses the 30 minute delay for authentication failures", () => {
    expect(new RetryBackoff().nextDelay({ authenticationFailure: true })).toBe(30 * 60_000);
  });
});
