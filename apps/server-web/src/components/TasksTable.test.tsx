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
            taskName: null,
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
    expect(screen.getByText("$0.10")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "eventCount-asc" } });
    expect(onSortChange).toHaveBeenCalledWith("eventCount-asc");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onNext).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("renders a task name as primary text with the full task ID beneath it", () => {
    render(
      <TasksTable
        rows={[
          {
            taskId: "task-named-123",
            taskName: "Named task",
            isFallback: false,
            startedAt: "2026-07-15T10:00:00.000Z",
            lastActivityAt: "2026-07-15T11:00:00.000Z",
            deviceId: "device-a",
            deviceName: "Device A",
            deviceCount: 1,
            projectId: "project-a",
            projectName: "Project A",
            projectCount: 1,
            eventCount: 1,
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 2,
            costUsd: 0
          }
        ]}
        total={1}
        limit={25}
        offset={0}
        sort="lastActivityAt-desc"
        onSortChange={() => undefined}
        onPrevious={() => undefined}
        onNext={() => undefined}
        t={(key) => key}
      />
    );

    const name = screen.getByText("Named task");
    const taskId = screen.getByText("task-named-123");
    expect(name.className).toContain("task-name");
    expect(taskId.className).toContain("task-id");
    expect(name.closest("td")?.getAttribute("title")).toBe("task-named-123");
  });
});
