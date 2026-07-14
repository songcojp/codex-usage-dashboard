import { describe, expect, it } from "vitest";
import { validateServerConfig } from "./config.js";

const production = {
  NODE_ENV: "production",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_PASSWORD: "strong-password",
  JWT_SECRET: "x".repeat(32),
  PUBLIC_BASE_URL: "https://dashboard.example.com"
};

describe("validateServerConfig", () => {
  it("accepts a complete HTTPS production configuration", () => {
    expect(() => validateServerConfig(production)).not.toThrow();
  });

  it.each(["ADMIN_EMAIL", "ADMIN_PASSWORD", "JWT_SECRET", "PUBLIC_BASE_URL"])(
    "rejects missing %s in production",
    (name) => expect(() => validateServerConfig({ ...production, [name]: "" })).toThrow(name)
  );

  it("rejects an HTTP production public URL", () => {
    expect(() => validateServerConfig({ ...production, PUBLIC_BASE_URL: "http://dashboard.example.com" }))
      .toThrow(/https/);
  });

  it("does not require production secrets during development", () => {
    expect(() => validateServerConfig({ NODE_ENV: "development" })).not.toThrow();
  });
});
