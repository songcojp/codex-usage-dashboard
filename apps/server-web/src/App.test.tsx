// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { App, resolveLanguageSetting, toReportingDateInputValue } from "./App.js";
import { createTrendChartOption } from "./components/TrendPanel.js";

const languageStorageKey = "codex-usage-dashboard-language";

describe("reporting date helpers", () => {
  test("formats date inputs using the selected reporting timezone", () => {
    expect(toReportingDateInputValue(new Date("2026-05-30T15:00:00.000Z"), "Asia/Tokyo")).toBe(
      "2026-05-31"
    );
    expect(toReportingDateInputValue(new Date("2026-05-30T15:00:00.000Z"), "UTC")).toBe("2026-05-30");
  });
});

describe("trend chart options", () => {
  test("includes cache tokens as a trend series", () => {
    const option = createTrendChartOption(
      [
        {
          day: "2026-05-30",
          totalTokens: 100,
          inputTokens: 40,
          outputTokens: 30,
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
          costUsd: 0.125,
          eventCount: 1
        }
      ],
      (key) => key,
      "en"
    );

    expect(option.series).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Cache",
          data: [30]
        })
      ])
    );
  });

  test.each([
    ["zh", "100万"],
    ["ja", "100万"],
    ["en", "1M"],
    ["ko", "100만"]
  ] as const)("formats y-axis labels using the selected %s dashboard language", (language, expected) => {
    const option = createTrendChartOption([], (key) => key, language);
    const formatter = option.yAxis.axisLabel.formatter;

    expect(formatter(1_000_000)).toBe(expected);
  });
});

describe("language selection", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.localStorage.clear();
  });

  test("resolves auto language from the browser language list", () => {
    expect(resolveLanguageSetting("auto", ["ko-KR", "en-US"])).toBe("ko");
    expect(resolveLanguageSetting("auto", ["ja-JP"])).toBe("ja");
    expect(resolveLanguageSetting("auto", ["zh-CN"])).toBe("zh");
    expect(resolveLanguageSetting("auto", ["fr-FR"])).toBe("en");
    expect(resolveLanguageSetting("en", ["ko-KR"])).toBe("en");
  });

  test("allows manual language selection and persists it", async () => {
    vi.stubGlobal("fetch", vi.fn(handleRequest));

    render(<App />);

    await screen.findByRole("heading", { name: "Admin login" });
    fireEvent.change(screen.getByLabelText("Language"), {
      target: { value: "zh" }
    });

    expect(await screen.findByRole("heading", { name: "管理员登录" })).toBeTruthy();
    expect(window.localStorage.getItem(languageStorageKey)).toBe("zh");
  });
});

describe("admin dashboard rendering", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  test("logs in and renders dashboard filters, metrics, pagination, and usage totals", async () => {
    vi.stubGlobal("fetch", vi.fn(handleRequest));

    render(<App />);

    await screen.findByRole("heading", { name: "Admin login" });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@example.com" }
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByRole("heading", { name: "Codex Usage Dashboard" });
    expect(screen.getByLabelText("Codex Usage Dashboard").textContent).toContain("Codex Usage");
    expect(screen.getByLabelText("Current UTC time").textContent).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/
    );
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    await screen.findByRole("option", { name: "Device A" });
    await screen.findByRole("option", { name: "claude-4" });
    const desktopOption = await screen.findByRole("option", { name: "Codex Desktop" });
    const vscodeOption = screen.getByRole("option", { name: "Codex VS Code" });
    expect((desktopOption as HTMLOptionElement).value).toBe("codex-desktop");
    expect((vscodeOption as HTMLOptionElement).value).toBe("codex-vscode-plugin");
    expect((desktopOption as HTMLOptionElement).value).not.toBe((vscodeOption as HTMLOptionElement).value);
    expect(screen.getByRole("option", { name: "Other" })).toBeTruthy();
    expect(screen.getByLabelText("Device")).toBeTruthy();
    expect(screen.getByLabelText("Project")).toBeTruthy();
    expect(screen.getByLabelText("Model")).toBeTruthy();
    expect(screen.getByLabelText("Time zone")).toBeTruthy();
    expect(screen.getByText("Cache read")).toBeTruthy();
    expect(screen.queryByText("Cache write")).toBeNull();
    expect(screen.getAllByText("Cost").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("$0.1250").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("2026-05-30 12:00 UTC")).toBeTruthy();
    expect(screen.queryByLabelText("Token metrics")?.textContent).not.toContain("Events");
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("tab", { name: "Devices" }));
    expect(screen.getAllByText("Device A").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("42")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
    expect(screen.getAllByText("Project A").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("84")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Prices" }));
    expect(screen.getByRole("heading", { name: "Model prices" })).toBeTruthy();
    expect(screen.getByDisplayValue("gpt-5")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Input USD / 1M"), {
      target: { value: "3" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save price" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/admin/model-prices",
        expect.objectContaining({ method: "POST" })
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete gpt-5 price" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/admin/model-prices/price-1",
        expect.objectContaining({ method: "DELETE" })
      );
    });

    fireEvent.change(screen.getByLabelText("Device"), {
      target: { value: "00000000-0000-4000-8000-000000000001" }
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("deviceId=00000000-0000-4000-8000-000000000001"),
        expect.anything()
      );
    });
    fireEvent.click(screen.getByRole("tab", { name: "Devices" }));
    await screen.findByText("142");

    fireEvent.change(screen.getByLabelText("Project"), {
      target: { value: "00000000-0000-4000-8000-000000000002" }
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("projectId=00000000-0000-4000-8000-000000000002"),
        expect.anything()
      );
    });
    fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
    await screen.findByText("184");

    fireEvent.click(screen.getByRole("tab", { name: "Events" }));
    fireEvent.change(screen.getByLabelText("Sort"), {
      target: { value: "cacheTokens-desc" }
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("sortBy=cacheTokens&sortDir=desc"),
        expect.anything()
      );
    });

    fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
    fireEvent.change(screen.getByLabelText("Sort"), {
      target: { value: "eventCount-desc" }
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/admin/projects?"),
        expect.anything()
      );
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("sortBy=eventCount&sortDir=desc"),
        expect.anything()
      );
    });

    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "UTC" }
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining("timeZone=UTC"), expect.anything());
    });

    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/admin/devices?"), expect.anything());
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/admin/projects?"), expect.anything());
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/admin/models?"), expect.anything());
    expect(fetch).toHaveBeenCalledWith("/api/admin/model-prices", expect.anything());
  });

  test("refreshes metric totals every 60 seconds without reloading dashboard tables", async () => {
    const intervals: Array<{ handler: TimerHandler; timeout?: number }> = [];
    vi.spyOn(window, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number) => {
      intervals.push({ handler, timeout });
      return intervals.length as unknown as ReturnType<typeof window.setInterval>;
    }) as unknown as typeof window.setInterval);
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    let summaryCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = input.toString();
      if (path.startsWith("/api/admin/summary")) {
        summaryCalls += 1;
        return response({
          totalTokens: summaryCalls === 1 ? 100 : 160,
          inputTokens: summaryCalls === 1 ? 40 : 70,
          outputTokens: summaryCalls === 1 ? 30 : 50,
          cacheReadTokens: summaryCalls === 1 ? 20 : 30,
          cacheWriteTokens: 10,
          costUsd: summaryCalls === 1 ? 0.125 : 0.25,
          eventCount: 60
        });
      }
      return handleRequest(input);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByRole("heading", { name: "Admin login" });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@example.com" }
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByRole("heading", { name: "Codex Usage Dashboard" });
    await screen.findByText("100");
    const eventsFetchesBefore = fetchMock.mock.calls.filter(([input]) =>
      input.toString().startsWith("/api/admin/events")
    ).length;
    const summaryInterval = intervals.find((interval) => interval.timeout === 60000);
    expect(summaryInterval).toBeTruthy();

    await act(async () => {
      if (typeof summaryInterval?.handler === "function") {
        summaryInterval.handler();
      }
      await Promise.resolve();
    });

    expect(screen.getByText("160")).toBeTruthy();
    expect(screen.getByText("$0.25")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([input]) => input.toString().startsWith("/api/admin/summary"))).toHaveLength(2);
    expect(
      fetchMock.mock.calls.filter(([input]) => input.toString().startsWith("/api/admin/events"))
    ).toHaveLength(eventsFetchesBefore);
  });

  test("renders metric totals with rolling digit columns", async () => {
    vi.stubGlobal("fetch", vi.fn(handleRequest));

    const { container } = render(<App />);

    await screen.findByRole("heading", { name: "Admin login" });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@example.com" }
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByRole("heading", { name: "Codex Usage Dashboard" });
    await waitFor(() => {
      const metricValues = [...container.querySelectorAll(".metric-value .sr-only")].map((node) => node.textContent);
      expect(metricValues).toContain("100");
    });
    expect(container.querySelectorAll(".metric-digit-window").length).toBeGreaterThan(0);
  });
});

function handleRequest(input: RequestInfo | URL) {
  const path = input.toString();
  if (path === "/api/admin/me") {
    return response({ error: "unauthorized" }, 401);
  }
  if (path === "/api/admin/login") {
    return response({ ok: true });
  }
  if (path.startsWith("/api/admin/summary")) {
    return response({
      totalTokens: 100,
      inputTokens: 40,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      costUsd: 0.125,
      eventCount: 60
    });
  }
  if (path.startsWith("/api/admin/trends")) {
    return response({ points: [] });
  }
  if (path.startsWith("/api/admin/project-ratios")) {
    return response({ daily: [], total: [] });
  }
  if (path.startsWith("/api/admin/events")) {
    return response({
      total: 60,
      rows: [
        {
          id: "event-1",
          occurredAt: "2026-05-30T12:00:00.000Z",
          tool: "codex-cli",
          deviceId: "00000000-0000-4000-8000-000000000001",
          projectId: "00000000-0000-4000-8000-000000000002",
          model: "gpt-5",
          inputTokens: 8,
          outputTokens: 7,
          cacheReadTokens: 6,
          cacheWriteTokens: 5,
          costUsd: 0.125,
          totalTokens: 26
        }
      ]
    });
  }
  if (path.startsWith("/api/admin/devices")) {
    const params = paramsFor(path);
    const isFilteredTotals = params.get("deviceId") === "00000000-0000-4000-8000-000000000001";
    return response({
      rows: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: "Device A",
          os: "linux",
          hostnameHash: "host-a",
          lastSeenAt: "2026-05-30T12:00:00.000Z",
          disabledAt: null,
          createdAt: "2026-05-30T00:00:00.000Z",
          totalTokens: isFilteredTotals ? 142 : 42,
          costUsd: isFilteredTotals ? 1.42 : 0.42,
          eventCount: 4
        }
      ]
    });
  }
  if (path.startsWith("/api/admin/projects")) {
    const params = paramsFor(path);
    const isFilteredTotals = params.get("projectId") === "00000000-0000-4000-8000-000000000002";
    return response({
      rows: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          displayName: "Project A",
          repoHash: "repo-a",
          remoteHash: "remote-a",
          pathHash: "path-a",
          createdAt: "2026-05-30T00:00:00.000Z",
          updatedAt: "2026-05-30T12:00:00.000Z",
          totalTokens: isFilteredTotals ? 184 : 84,
          costUsd: isFilteredTotals ? 1.84 : 0.84,
          eventCount: 8
        }
      ]
    });
  }
  if (path.startsWith("/api/admin/models")) {
    return response({
      rows: [{ model: "claude-4" }, { model: "gpt-5" }]
    });
  }
  if (path === "/api/admin/tools") {
    return response({
      rows: [
        { id: "tool-1", slug: "codex-cli", displayName: "Codex CLI", createdAt: "2026-05-30T00:00:00.000Z" },
        { id: "tool-2", slug: "codex-vscode-plugin", displayName: "Codex VS Code", createdAt: "2026-05-30T00:00:00.000Z" },
        { id: "tool-3", slug: "codex-desktop", displayName: "Codex Desktop", createdAt: "2026-05-30T00:00:00.000Z" },
        { id: "tool-4", slug: "other", displayName: "Other", createdAt: "2026-05-30T00:00:00.000Z" }
      ]
    });
  }
  if (path === "/api/admin/model-prices") {
    return response({
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
  }
  if (path === "/api/admin/model-prices/price-1") {
    return response({ id: "price-1" });
  }
  return response({ error: "not found" }, 404);
}

function paramsFor(path: string): URLSearchParams {
  return new URL(path, "http://localhost").searchParams;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
