// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TasksTable } from "./TasksTable.js";

describe("TasksTable", () => {
  afterEach(cleanup);

  test("renders grouped usage, fallback labels, multiple values, sorting, and pagination", () => {
    const onSortChange = vi.fn();
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    render(
      <TasksTable
        rows={[
          {
            taskId: "fallback:device-a",
            isFallback: true,
            startedAt: "2026-07-15T10:00:00.000Z",
            lastActivityAt: "2026-07-15T11:00:00.000Z",
            deviceId: null,
            deviceName: null,
            deviceCount: 2,
            projectId: "project-a",
            projectName: "Project A",
            projectCount: 1,
            eventCount: 3,
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
            totalTokens: 16,
            costUsd: 0.1
          }
        ]}
        total={30}
        limit={25}
        offset={0}
        sort="lastActivityAt-desc"
        onSortChange={onSortChange}
        onPrevious={onPrevious}
        onNext={onNext}
        t={(key) => key}
      />
    );

    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(screen.getByText("Fallback")).toBeTruthy();
    const fallbackId = screen.getByText("fallback:device-a");
    expect(fallbackId).toBeTruthy();
    expect(fallbackId.closest("td")?.getAttribute("title")).toBe("fallback:device-a");
    expect(screen.getByText("Multiple (2)")).toBeTruthy();
    expect(screen.getByText("Project A")).toBeTruthy();
    expect(screen.getByText("16")).toBeTruthy();
    expect(screen.getByText("$0.1000")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "eventCount-asc" } });
    expect(onSortChange).toHaveBeenCalledWith("eventCount-asc");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onNext).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
