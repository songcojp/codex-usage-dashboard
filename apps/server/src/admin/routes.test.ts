import { hashToken } from "@codex-usage-dashboard/shared";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { AdminQueryService, UsageFilters } from "./queries.js";

const env = {
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_PASSWORD: "secret",
  JWT_SECRET: "test-secret"
};

const filters = {
  from: "2026-05-01",
  to: "2026-05-30"
};
const validDeviceId = "00000000-0000-4000-8000-000000000001";

function createQueryService(): AdminQueryService {
  return {
    async getSummary() {
      return {
        totalTokens: 10,
        inputTokens: 4,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        costUsd: 0.125,
        eventCount: 5
      };
    },
    async getTrends() {
      return { points: [] };
    },
    async getProjectRatios() {
      return { daily: [], total: [] };
    },
    async getEvents() {
      return { rows: [], total: 0 };
    },
    async listDevices() {
      return { rows: [] };
    },
    async createDevice(input) {
      return {
        id: "device-1",
        name: input.name,
        os: input.os,
        hostnameHash: input.hostnameHash,
        token: input.token
      };
    },
    async disableDevice(id) {
      return { id, disabledAt: "2026-05-30T00:00:00.000Z" };
    },
    async listProjects() {
      return { rows: [] };
    },
    async listModels() {
      return { rows: [] };
    },
    async listTools() {
      return { rows: [] };
    },
    async listModelPrices() {
      return { rows: [] };
    },
    async upsertModelPrice(input) {
      return {
        id: "price-1",
        ...input,
        toolId: "tool-1",
        createdAt: "2026-05-30T00:00:00.000Z",
        updatedAt: "2026-05-30T00:00:00.000Z"
      };
    },
    async deleteModelPrice(id) {
      return { id };
    }
  };
}

async function login() {
  const app = await buildApp({ adminQueryService: createQueryService(), env });
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    payload: {
      email: "admin@example.com",
      password: "secret"
    }
  });

  return { app, response };
}

describe("admin routes", () => {
  it("returns project ratios without applying the selected project", async () => {
    let seenFilters: UsageFilters | undefined;
    const queryService = createQueryService();
    queryService.getProjectRatios = async (nextFilters) => {
      seenFilters = nextFilters;
      return { daily: [], total: [] };
    };
    const app = await buildApp({ adminQueryService: queryService, env });

    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: { email: "admin@example.com", password: "secret" }
      });
      const cookie = loginResponse.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
      const response = await app.inject({
        method: "GET",
        url: `/api/admin/project-ratios?from=2026-07-01&to=2026-07-15&timeZone=UTC&tool=codex-cli&projectId=${validDeviceId}`,
        headers: { cookie }
      });

      expect(response.statusCode).toBe(200);
      expect(seenFilters).toMatchObject({
        from: "2026-07-01",
        to: "2026-07-15",
        tool: "codex-cli",
        timeZone: "UTC"
      });
      expect(seenFilters?.projectId).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("rejects protected routes without an admin session", async () => {
    const app = await buildApp({ adminQueryService: createQueryService(), env });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/me"
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized" });
    } finally {
      await app.close();
    }
  });

  it("sets an HTTP-only session cookie after successful login", async () => {
    const { app, response } = await login();

    try {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(response.headers["set-cookie"]).toContain("admin_session=");
      expect(response.headers["set-cookie"]).toContain("HttpOnly");
      expect(response.headers["set-cookie"]).toContain("SameSite=Lax");
    } finally {
      await app.close();
    }
  });

  it("does not set a secure admin cookie for a development HTTP base URL", async () => {
    const app = await buildApp({
      adminQueryService: createQueryService(),
      env: { ...env, NODE_ENV: "development", PUBLIC_BASE_URL: "http://dashboard.example.com" }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "admin@example.com",
          password: "secret"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["set-cookie"]).toContain("admin_session=");
      expect(response.headers["set-cookie"]).not.toContain("Secure");
    } finally {
      await app.close();
    }
  });

  it("sets a secure admin cookie for an HTTPS public base URL", async () => {
    const app = await buildApp({
      adminQueryService: createQueryService(),
      env: { ...env, NODE_ENV: "production", PUBLIC_BASE_URL: "https://dashboard.example.com" }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "admin@example.com",
          password: "secret"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["set-cookie"]).toContain("admin_session=");
      expect(response.headers["set-cookie"]).toContain("Secure");
      expect(response.headers["set-cookie"]).toContain("HttpOnly");
      expect(response.headers["set-cookie"]).toContain("SameSite=Lax");
    } finally {
      await app.close();
    }
  });

  it("rejects invalid login credentials", async () => {
    const app = await buildApp({ adminQueryService: createQueryService(), env });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "admin@example.com",
          password: "wrong"
        }
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "invalid credentials" });
    } finally {
      await app.close();
    }
  });

  it("returns 429 on the attempt after five failed logins", async () => {
    const app = await buildApp({ adminQueryService: createQueryService(), env });
    try {
      for (let index = 0; index < 5; index += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/admin/login",
          payload: { email: "admin@example.com", password: "wrong" }
        });
        expect(response.statusCode).toBe(401);
      }
      const blocked = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: { email: "admin@example.com", password: "secret" }
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toEqual({ error: "too many login attempts" });
    } finally {
      await app.close();
    }
  });

  it("rejects blank login credentials and blank configured credentials", async () => {
    const blankRequestApp = await buildApp({ adminQueryService: createQueryService(), env });

    try {
      const response = await blankRequestApp.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "",
          password: "secret"
        }
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "invalid credentials" });
    } finally {
      await blankRequestApp.close();
    }

    const blankEnvApp = await buildApp({
      adminQueryService: createQueryService(),
      env: {
        ADMIN_EMAIL: "",
        ADMIN_PASSWORD: "",
        JWT_SECRET: "test-secret"
      }
    });

    try {
      const response = await blankEnvApp.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "",
          password: ""
        }
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "invalid credentials" });
    } finally {
      await blankEnvApp.close();
    }
  });

  it("clears the admin session even without an admin session", async () => {
    const app = await buildApp({ adminQueryService: createQueryService(), env });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/logout"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(response.headers["set-cookie"]).toContain("admin_session=");
      expect(response.headers["set-cookie"]).toContain("Max-Age=0");
    } finally {
      await app.close();
    }
  });

  it("rejects sessions for an old admin email", async () => {
    const { app, response: loginResponse } = await login();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/me",
        headers: {
          cookie: loginResponse.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
        }
      });

      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }

    const changedEnvApp = await buildApp({
      adminQueryService: createQueryService(),
      env: {
        ADMIN_EMAIL: "new-admin@example.com",
        ADMIN_PASSWORD: "secret",
        JWT_SECRET: "test-secret"
      }
    });

    try {
      const response = await changedEnvApp.inject({
        method: "GET",
        url: "/api/admin/me",
        headers: {
          cookie: loginResponse.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
        }
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized" });
    } finally {
      await changedEnvApp.close();
    }
  });

  it("returns the current admin when a session cookie is present", async () => {
    const { app, response: loginResponse } = await login();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/me",
        headers: {
          cookie: loginResponse.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ email: "admin@example.com" });
    } finally {
      await app.close();
    }
  });

  it("passes usage filters to summary queries", async () => {
    let seenFilters;
    const queryService = createQueryService();
    queryService.getSummary = async (input) => {
      seenFilters = input;
      return {
        totalTokens: 10,
        inputTokens: 4,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        costUsd: 0.125,
        eventCount: 5
      };
    };
    const app = await buildApp({ adminQueryService: queryService, env });

    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "admin@example.com",
          password: "secret"
        }
      });
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/summary?from=2026-05-01&to=2026-05-30&tool=codex-cli&timeZone=UTC",
        headers: {
          cookie: loginResponse.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        totalTokens: 10,
        inputTokens: 4,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        costUsd: 0.125,
        eventCount: 5
      });
      expect(seenFilters).toMatchObject({ ...filters, tool: "codex-cli", timeZone: "UTC" });
    } finally {
      await app.close();
    }
  });

  it("returns 400 for bad date filters without calling the query service", async () => {
    let called = false;
    const queryService = createQueryService();
    queryService.getSummary = async () => {
      called = true;
      return {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        eventCount: 0
      };
    };
    const app = await buildApp({ adminQueryService: queryService, env });

    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "admin@example.com",
          password: "secret"
        }
      });
      const cookie = loginResponse.cookies.map((item) => `${item.name}=${item.value}`).join("; ");

      for (const url of [
        "/api/admin/summary?from=bad&to=2026-05-30",
        "/api/admin/summary?from=2026-05-01&to=2026-02-01",
        "/api/admin/summary?from=2026-02-30&to=2026-05-30",
        "/api/admin/summary?from=2026-05-01&to=2026-05-30&deviceId=not-a-uuid",
        "/api/admin/summary?from=2026-05-01&to=2026-05-30&projectId=not-a-uuid",
        "/api/admin/summary?from=2026-05-01&to=2026-05-30&timeZone=Not/AZone"
      ]) {
        const response = await app.inject({
          method: "GET",
          url,
          headers: { cookie }
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid filters" });
      }

      expect(called).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("returns 400 for malformed pagination without calling the query service", async () => {
    let called = false;
    const queryService = createQueryService();
    queryService.getEvents = async () => {
      called = true;
      return { rows: [], total: 0 };
    };
    const app = await buildApp({ adminQueryService: queryService, env });

    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "admin@example.com",
          password: "secret"
        }
      });
      const cookie = loginResponse.cookies.map((item) => `${item.name}=${item.value}`).join("; ");

      for (const url of [
        "/api/admin/events?from=2026-05-01&to=2026-05-30&limit=abc",
        "/api/admin/events?from=2026-05-01&to=2026-05-30&offset=abc",
        "/api/admin/events?from=2026-05-01&to=2026-05-30&limit=-1",
        "/api/admin/events?from=2026-05-01&to=2026-05-30&offset=-1"
      ]) {
        const response = await app.inject({
          method: "GET",
          url,
          headers: { cookie }
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid filters" });
      }

      expect(called).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("passes event sort parameters to the paginated events query", async () => {
    let seenInput;
    const queryService = createQueryService();
    queryService.getEvents = async (input) => {
      seenInput = input;
      return { rows: [], total: 0 };
    };
    const app = await buildApp({ adminQueryService: queryService, env });

    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "admin@example.com",
          password: "secret"
        }
      });
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/events?from=2026-05-01&to=2026-05-30&limit=25&offset=50&sortBy=cacheTokens&sortDir=asc",
        headers: {
          cookie: loginResponse.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
        }
      });

      expect(response.statusCode).toBe(200);
      expect(seenInput).toMatchObject({
        ...filters,
        timeZone: "Asia/Tokyo",
        limit: 25,
        offset: 50,
        sortBy: "cacheTokens",
        sortDir: "asc"
      });
    } finally {
      await app.close();
    }
  });

  it("passes project sort parameters to the projects query", async () => {
    let seenInput;
    const queryService = createQueryService();
    queryService.listProjects = async (input) => {
      seenInput = input;
      return { rows: [] };
    };
    const app = await buildApp({ adminQueryService: queryService, env });

    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "admin@example.com",
          password: "secret"
        }
      });
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/projects?from=2026-05-01&to=2026-05-30&sortBy=eventCount&sortDir=desc",
        headers: {
          cookie: loginResponse.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
        }
      });

      expect(response.statusCode).toBe(200);
      expect(seenInput).toMatchObject({
        ...filters,
        timeZone: "Asia/Tokyo",
        sortBy: "eventCount",
        sortDir: "desc"
      });
    } finally {
      await app.close();
    }
  });

  it("returns 400 for unsupported project sort parameters", async () => {
    let called = false;
    const queryService = createQueryService();
    queryService.listProjects = async () => {
      called = true;
      return { rows: [] };
    };
    const app = await buildApp({ adminQueryService: queryService, env });

    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "admin@example.com",
          password: "secret"
        }
      });
      const cookie = loginResponse.cookies.map((item) => `${item.name}=${item.value}`).join("; ");

      for (const url of [
        "/api/admin/projects?from=2026-05-01&to=2026-05-30&sortBy=model",
        "/api/admin/projects?from=2026-05-01&to=2026-05-30&sortDir=sideways"
      ]) {
        const response = await app.inject({
          method: "GET",
          url,
          headers: { cookie }
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid filters" });
      }

      expect(called).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("returns 400 for unsupported event sort parameters", async () => {
    let called = false;
    const queryService = createQueryService();
    queryService.getEvents = async () => {
      called = true;
      return { rows: [], total: 0 };
    };
    const app = await buildApp({ adminQueryService: queryService, env });

    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "admin@example.com",
          password: "secret"
        }
      });
      const cookie = loginResponse.cookies.map((item) => `${item.name}=${item.value}`).join("; ");

      for (const url of [
        "/api/admin/events?from=2026-05-01&to=2026-05-30&sortBy=model",
        "/api/admin/events?from=2026-05-01&to=2026-05-30&sortDir=sideways"
      ]) {
        const response = await app.inject({
          method: "GET",
          url,
          headers: { cookie }
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid filters" });
      }

      expect(called).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("passes filters to model, device, and project dashboard queries", async () => {
    const seen: Record<string, unknown> = {};
    const queryService = createQueryService();
    queryService.listModels = async (input) => {
      seen.models = input;
      return { rows: [{ model: "gpt-5" }] };
    };
    queryService.listDevices = async (input) => {
      seen.devices = input;
      return { rows: [] };
    };
    queryService.listProjects = async (input) => {
      seen.projects = input;
      return { rows: [] };
    };
    const app = await buildApp({ adminQueryService: queryService, env });

    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "admin@example.com",
          password: "secret"
        }
      });
      const cookie = loginResponse.cookies.map((item) => `${item.name}=${item.value}`).join("; ");

      const modelResponse = await app.inject({
        method: "GET",
        url: `/api/admin/models?from=2026-05-01&to=2026-05-30&tool=codex-cli&deviceId=${validDeviceId}`,
        headers: { cookie }
      });
      const devicesResponse = await app.inject({
        method: "GET",
        url: "/api/admin/devices?from=2026-05-01&to=2026-05-30&tool=codex-cli&model=gpt-5",
        headers: { cookie }
      });
      const projectsResponse = await app.inject({
        method: "GET",
        url: `/api/admin/projects?from=2026-05-01&to=2026-05-30&tool=codex-cli&model=gpt-5&deviceId=${validDeviceId}`,
        headers: { cookie }
      });

      expect(modelResponse.statusCode).toBe(200);
      expect(modelResponse.json()).toEqual({ rows: [{ model: "gpt-5" }] });
      expect(devicesResponse.statusCode).toBe(200);
      expect(projectsResponse.statusCode).toBe(200);
      expect(seen.models).toMatchObject({
        ...filters,
        timeZone: "Asia/Tokyo",
        tool: "codex-cli",
        deviceId: validDeviceId
      });
      expect(seen.devices).toMatchObject({
        ...filters,
        timeZone: "Asia/Tokyo",
        tool: "codex-cli",
        model: "gpt-5"
      });
      expect(seen.projects).toMatchObject({
        ...filters,
        timeZone: "Asia/Tokyo",
        tool: "codex-cli",
        model: "gpt-5",
        deviceId: validDeviceId
      });
    } finally {
      await app.close();
    }
  });

  it("creates devices with a plaintext token returned once", async () => {
    const app = await buildApp({ adminQueryService: createQueryService(), env });

    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "admin@example.com",
          password: "secret"
        }
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/devices",
        headers: {
          cookie: loginResponse.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
        },
        payload: {
          name: "Workstation",
          os: "linux"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: "device-1",
        name: "Workstation",
        os: "linux",
        hostnameHash: ""
      });
      expect(response.json().token).toMatch(/^trd_/);
      expect(hashToken(response.json().token)).toHaveLength(64);
    } finally {
      await app.close();
    }
  });

  it("trims device name and os and rejects blank device fields", async () => {
    const seenInputs: Array<{ name: string; os: string; hostnameHash: string; token: string }> = [];
    const queryService = createQueryService();
    queryService.createDevice = async (input) => {
      seenInputs.push(input);
      return {
        id: validDeviceId,
        name: input.name,
        os: input.os,
        hostnameHash: input.hostnameHash,
        token: input.token
      };
    };
    const app = await buildApp({ adminQueryService: queryService, env });

    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "admin@example.com",
          password: "secret"
        }
      });
      const cookie = loginResponse.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
      const trimmed = await app.inject({
        method: "POST",
        url: "/api/admin/devices",
        headers: { cookie },
        payload: {
          name: "  Workstation  ",
          os: "  linux  "
        }
      });
      const blank = await app.inject({
        method: "POST",
        url: "/api/admin/devices",
        headers: { cookie },
        payload: {
          name: "   ",
          os: "linux"
        }
      });

      expect(trimmed.statusCode).toBe(200);
      expect(trimmed.json()).toMatchObject({ name: "Workstation", os: "linux" });
      expect(seenInputs[0]).toMatchObject({ name: "Workstation", os: "linux" });
      expect(blank.statusCode).toBe(400);
      expect(blank.json()).toEqual({ error: "invalid device" });
      expect(seenInputs).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("exposes the remaining admin query endpoints", async () => {
    const queryService = createQueryService();
    queryService.getTrends = async () => ({ points: [{ day: "2026-05-30", totalTokens: 10 }] });
    queryService.getEvents = async () => ({ rows: [{ id: "event-1" }], total: 1 });
    queryService.listDevices = async () => ({ rows: [{ id: "device-1" }] });
    queryService.listProjects = async () => ({ rows: [{ id: "project-1" }] });
    queryService.listTools = async () => ({ rows: [{ slug: "codex-cli" }] });
    const app = await buildApp({ adminQueryService: queryService, env });

    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "admin@example.com",
          password: "secret"
        }
      });
      const cookie = loginResponse.cookies.map((item) => `${item.name}=${item.value}`).join("; ");

      const trends = await app.inject({
        method: "GET",
        url: "/api/admin/trends?from=2026-05-01&to=2026-05-30",
        headers: { cookie }
      });
      const events = await app.inject({
        method: "GET",
        url: "/api/admin/events?from=2026-05-01&to=2026-05-30",
        headers: { cookie }
      });
      const devices = await app.inject({
        method: "GET",
        url: "/api/admin/devices",
        headers: { cookie }
      });
      const disabled = await app.inject({
        method: "POST",
        url: `/api/admin/devices/${validDeviceId}/disable`,
        headers: { cookie }
      });
      const projects = await app.inject({
        method: "GET",
        url: "/api/admin/projects",
        headers: { cookie }
      });
      const tools = await app.inject({
        method: "GET",
        url: "/api/admin/tools",
        headers: { cookie }
      });

      expect(trends.json()).toEqual({ points: [{ day: "2026-05-30", totalTokens: 10 }] });
      expect(events.json()).toEqual({ rows: [{ id: "event-1" }], total: 1 });
      expect(devices.json()).toEqual({ rows: [{ id: "device-1" }] });
      expect(disabled.json()).toEqual({
        id: validDeviceId,
        disabledAt: "2026-05-30T00:00:00.000Z"
      });
      expect(projects.json()).toEqual({ rows: [{ id: "project-1" }] });
      expect(tools.json()).toEqual({ rows: [{ slug: "codex-cli" }] });
    } finally {
      await app.close();
    }
  });

  it("manages model prices through protected admin routes", async () => {
    const seen: Record<string, unknown> = {};
    const queryService = createQueryService();
    queryService.listModelPrices = async () => ({
      rows: [
        {
          id: "price-1",
          model: "gpt-5",
          inputCostPerMillionUsd: 2,
          outputCostPerMillionUsd: 10,
          cacheReadCostPerMillionUsd: 0.5,
          cacheWriteCostPerMillionUsd: 1,
          createdAt: "2026-05-30T00:00:00.000Z",
          updatedAt: "2026-05-30T00:00:00.000Z"
        }
      ]
    });
    queryService.upsertModelPrice = async (input) => {
      seen.upsert = input;
      return { id: "price-1", ...input };
    };
    queryService.deleteModelPrice = async (id) => {
      seen.deleted = id;
      return { id };
    };
    const app = await buildApp({ adminQueryService: queryService, env });

    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "admin@example.com",
          password: "secret"
        }
      });
      const cookie = loginResponse.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
      const list = await app.inject({
        method: "GET",
        url: "/api/admin/model-prices",
        headers: { cookie }
      });
      const upsert = await app.inject({
        method: "POST",
        url: "/api/admin/model-prices",
        headers: { cookie },
        payload: {
          model: "gpt-5",
          inputCostPerMillionUsd: 2,
          outputCostPerMillionUsd: 10,
          cacheReadCostPerMillionUsd: 0.5,
          cacheWriteCostPerMillionUsd: 1
        }
      });
      const deleted = await app.inject({
        method: "DELETE",
        url: "/api/admin/model-prices/00000000-0000-4000-8000-000000000003",
        headers: { cookie }
      });

      expect(list.statusCode).toBe(200);
      expect(list.json().rows[0]).toMatchObject({ model: "gpt-5" });
      expect(upsert.statusCode).toBe(200);
      expect(seen.upsert).toEqual({
        model: "gpt-5",
        inputCostPerMillionUsd: 2,
        outputCostPerMillionUsd: 10,
        cacheReadCostPerMillionUsd: 0.5,
        cacheWriteCostPerMillionUsd: 1
      });
      expect(deleted.statusCode).toBe(200);
      expect(seen.deleted).toBe("00000000-0000-4000-8000-000000000003");
    } finally {
      await app.close();
    }
  });

  it("rejects malformed model price payloads before calling the query service", async () => {
    let called = false;
    const queryService = createQueryService();
    queryService.upsertModelPrice = async () => {
      called = true;
      return {};
    };
    const app = await buildApp({ adminQueryService: queryService, env });

    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "admin@example.com",
          password: "secret"
        }
      });
      const cookie = loginResponse.cookies.map((item) => `${item.name}=${item.value}`).join("; ");

      for (const payload of [
        { model: "", inputCostPerMillionUsd: 1, outputCostPerMillionUsd: 1, cacheReadCostPerMillionUsd: 0, cacheWriteCostPerMillionUsd: 0 },
        { model: "gpt-5", inputCostPerMillionUsd: -1, outputCostPerMillionUsd: 1, cacheReadCostPerMillionUsd: 0, cacheWriteCostPerMillionUsd: 0 }
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/admin/model-prices",
          headers: { cookie },
          payload
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid model price" });
      }

      expect(called).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("returns 400 for invalid device disable ids without calling the query service", async () => {
    let called = false;
    const queryService = createQueryService();
    queryService.disableDevice = async () => {
      called = true;
      return null;
    };
    const app = await buildApp({ adminQueryService: queryService, env });

    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        payload: {
          email: "admin@example.com",
          password: "secret"
        }
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/devices/not-a-uuid/disable",
        headers: {
          cookie: loginResponse.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
        }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid device id" });
      expect(called).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("clears the admin session on logout", async () => {
    const { app, response: loginResponse } = await login();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/logout",
        headers: {
          cookie: loginResponse.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(response.headers["set-cookie"]).toContain("admin_session=");
      expect(response.headers["set-cookie"]).toContain("Max-Age=0");
    } finally {
      await app.close();
    }
  });
});
