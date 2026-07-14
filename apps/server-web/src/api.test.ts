import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, apiGet, getDashboardData, logout } from "./api.js";

describe("admin API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("preserves response status on failed GET requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401
      })
    );

    await expect(apiGet("/api/admin/me")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      message: "GET /api/admin/me failed: 401"
    } satisfies Partial<ApiError>);
  });

  test("logout posts with admin session credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200
    });
    vi.stubGlobal("fetch", fetchMock);

    await logout();

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/logout", {
      method: "POST",
      credentials: "include"
    });
  });

  test("fetches filtered device and project totals separately from broader options", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = input.toString();
      if (path.startsWith("/api/admin/summary")) return jsonResponse(emptySummary());
      if (path.startsWith("/api/admin/trends")) return jsonResponse({ points: [] });
      if (path.startsWith("/api/admin/events")) return jsonResponse({ rows: [], total: 0 });
      if (path.startsWith("/api/admin/devices")) return jsonResponse({ rows: [] });
      if (path.startsWith("/api/admin/projects")) return jsonResponse({ rows: [] });
      if (path.startsWith("/api/admin/models")) return jsonResponse({ rows: [] });
      if (path === "/api/admin/tools") return jsonResponse({ rows: [] });
      if (path === "/api/admin/model-prices") return jsonResponse({ rows: [] });
      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    await getDashboardData(
      {
        from: "2026-05-01",
        to: "2026-05-30",
        tool: "codex-cli",
        deviceId: "00000000-0000-4000-8000-000000000001",
        projectId: "00000000-0000-4000-8000-000000000002",
        model: "gpt-5",
        timeZone: "UTC"
      },
      { limit: 25, offset: 0, sortBy: "cacheTokens", sortDir: "desc" },
      { sortBy: "totalTokens", sortDir: "asc" }
    );

    const paths = fetchMock.mock.calls.map(([path]) => path.toString());
    expect(paths).toContain(
      "/api/admin/devices?from=2026-05-01&to=2026-05-30&tool=codex-cli&deviceId=00000000-0000-4000-8000-000000000001&projectId=00000000-0000-4000-8000-000000000002&model=gpt-5&timeZone=UTC"
    );
    expect(paths).toContain(
      "/api/admin/projects?from=2026-05-01&to=2026-05-30&tool=codex-cli&deviceId=00000000-0000-4000-8000-000000000001&projectId=00000000-0000-4000-8000-000000000002&model=gpt-5&timeZone=UTC&sortBy=totalTokens&sortDir=asc"
    );
    expect(paths).toContain(
      "/api/admin/devices?from=2026-05-01&to=2026-05-30&tool=codex-cli&projectId=00000000-0000-4000-8000-000000000002&model=gpt-5&timeZone=UTC"
    );
    expect(paths).toContain(
      "/api/admin/projects?from=2026-05-01&to=2026-05-30&tool=codex-cli&deviceId=00000000-0000-4000-8000-000000000001&model=gpt-5&timeZone=UTC"
    );
    expect(paths).toContain(
      "/api/admin/events?from=2026-05-01&to=2026-05-30&tool=codex-cli&deviceId=00000000-0000-4000-8000-000000000001&projectId=00000000-0000-4000-8000-000000000002&model=gpt-5&timeZone=UTC&limit=25&offset=0&sortBy=cacheTokens&sortDir=desc"
    );
  });
});

function emptySummary() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    eventCount: 0
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
