// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FilterToolbar } from "./FilterToolbar.js";

const filters = {
  from: "2026-07-01",
  to: "2026-07-14",
  timeZone: "Asia/Tokyo"
};

function renderToolbar(onChange = vi.fn()) {
  return render(
    <FilterToolbar
      deviceOptions={[{ id: "device-1", name: "Device A" }]}
      filters={filters}
      modelOptions={["gpt-5"]}
      onChange={onChange}
      projectOptions={[{ id: "project-1", displayName: "Project A" }]}
      t={(key) => key}
      timeZoneOptions={[
        { value: "Asia/Tokyo", label: "Japan" },
        { value: "UTC", label: "UTC" }
      ]}
      toolOptions={[{ id: "tool-1", slug: "codex", displayName: "Codex" }]}
    />
  );
}

describe("FilterToolbar", () => {
  afterEach(cleanup);

  test("orders primary filters as date, time zone, project, and tool", () => {
    const { container } = renderToolbar();

    const primary = container.querySelector(".filter-toolbar-primary");
    const labels = [...(primary?.querySelectorAll("input, select") ?? [])].map(
      (control) => control.closest("label")?.querySelector("span")?.textContent
    );

    expect(labels).toEqual(["From", "To", "Time zone", "Project", "Tool"]);
  });

  test("keeps time zone visible and discloses device and model filters", () => {
    renderToolbar();

    expect(screen.getByLabelText("From")).toBeTruthy();
    expect(screen.getByLabelText("Time zone")).toBeTruthy();
    expect(screen.getByLabelText("Project")).toBeTruthy();
    expect(screen.queryByLabelText("Device")).toBeNull();
    expect(screen.queryByLabelText("Model")).toBeNull();

    const trigger = screen.getByRole("button", { name: "More filters" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Device")).toBeTruthy();
    expect(screen.getByLabelText("Model")).toBeTruthy();
  });

  test("secondary filters still update immediately", () => {
    const onChange = vi.fn();
    renderToolbar(onChange);

    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-5" } });
    expect(onChange).toHaveBeenCalledWith("model", "gpt-5");
  });
});
