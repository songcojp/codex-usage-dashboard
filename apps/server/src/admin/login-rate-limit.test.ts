import { describe, expect, it } from "vitest";
import { LoginRateLimiter } from "./login-rate-limit.js";

describe("LoginRateLimiter", () => {
  it("blocks after five failures and resets after success", () => {
    let now = 0;
    const limiter = new LoginRateLimiter({ now: () => now });
    for (let index = 0; index < 5; index += 1) expect(limiter.recordFailure("client")).toBe(false);
    expect(limiter.isBlocked("client")).toBe(true);
    limiter.reset("client");
    expect(limiter.isBlocked("client")).toBe(false);
    now += 1;
  });

  it("expires at the fifteen-minute boundary", () => {
    let now = 0;
    const limiter = new LoginRateLimiter({ now: () => now });
    for (let index = 0; index < 5; index += 1) limiter.recordFailure("client");
    now = 15 * 60 * 1000;
    expect(limiter.isBlocked("client")).toBe(false);
  });

  it("caps entries and evicts the oldest client", () => {
    let now = 0;
    const limiter = new LoginRateLimiter({ now: () => now, capacity: 10_000 });
    for (let index = 0; index < 10_001; index += 1) {
      now = index;
      limiter.recordFailure(`client-${index}`);
    }
    expect(limiter.size).toBe(10_000);
    expect(limiter.has("client-0")).toBe(false);
    expect(limiter.has("client-10000")).toBe(true);
  });

  it("periodically removes expired entries", () => {
    let now = 0;
    const limiter = new LoginRateLimiter({ now: () => now, cleanupIntervalMs: 10 });
    limiter.recordFailure("expired");
    now = 15 * 60 * 1000;
    limiter.recordFailure("current");
    expect(limiter.has("expired")).toBe(false);
    expect(limiter.has("current")).toBe(true);
  });
});
