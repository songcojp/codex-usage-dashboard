import { describe, expect, it } from "vitest";
import {
  createAdminSessionToken,
  verifyAdminCredentials,
  verifyAdminSessionToken
} from "./auth.js";

describe("verifyAdminCredentials", () => {
  it("accepts exact environment credentials", () => {
    expect(
      verifyAdminCredentials("admin@example.com", "secret", {
        ADMIN_EMAIL: "admin@example.com",
        ADMIN_PASSWORD: "secret"
      })
    ).toBe(true);
  });

  it("rejects wrong credentials", () => {
    expect(
      verifyAdminCredentials("admin@example.com", "wrong", {
        ADMIN_EMAIL: "admin@example.com",
        ADMIN_PASSWORD: "secret"
      })
    ).toBe(false);
  });

  it("rejects blank configured credentials", () => {
    expect(
      verifyAdminCredentials("", "", {
        ADMIN_EMAIL: "",
        ADMIN_PASSWORD: ""
      })
    ).toBe(false);
  });

  it("rejects blank submitted credentials", () => {
    expect(
      verifyAdminCredentials("", "secret", {
        ADMIN_EMAIL: "admin@example.com",
        ADMIN_PASSWORD: "secret"
      })
    ).toBe(false);
    expect(
      verifyAdminCredentials("admin@example.com", "", {
        ADMIN_EMAIL: "admin@example.com",
        ADMIN_PASSWORD: "secret"
      })
    ).toBe(false);
  });
});

describe("admin session tokens", () => {
  it("accepts a fresh token for the current admin email", () => {
    const token = createAdminSessionToken("admin@example.com", "secret", {
      now: new Date("2026-05-30T00:00:00.000Z")
    });

    expect(
      verifyAdminSessionToken(token, "secret", {
        adminEmail: "admin@example.com",
        now: new Date("2026-05-30T00:01:00.000Z")
      })
    ).toEqual({ email: "admin@example.com" });
  });

  it("rejects a tampered token", () => {
    const token = createAdminSessionToken("admin@example.com", "secret");
    const [, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        v: "v1",
        email: "owner@example.com",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60
      })
    ).toString("base64url");
    const tampered = `${tamperedPayload}.${signature}`;

    expect(
      verifyAdminSessionToken(tampered, "secret", {
        adminEmail: "admin@example.com"
      })
    ).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = createAdminSessionToken("admin@example.com", "secret", {
      now: new Date("2026-05-01T00:00:00.000Z")
    });

    expect(
      verifyAdminSessionToken(token, "secret", {
        adminEmail: "admin@example.com",
        now: new Date("2026-05-09T00:00:01.000Z")
      })
    ).toBeNull();
  });

  it("rejects a token for a non-current admin email", () => {
    const token = createAdminSessionToken("old@example.com", "secret");

    expect(
      verifyAdminSessionToken(token, "secret", {
        adminEmail: "admin@example.com"
      })
    ).toBeNull();
  });

  it("rejects a token when the current admin email is not configured", () => {
    const token = createAdminSessionToken("admin@example.com", "secret");

    expect(
      verifyAdminSessionToken(token, "secret", {
        adminEmail: ""
      })
    ).toBeNull();
  });
});
