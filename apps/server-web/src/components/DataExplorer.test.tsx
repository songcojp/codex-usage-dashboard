// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { useState } from "react";
import type { DashboardTab } from "../dashboard-types.js";
import { DataExplorer } from "./DataExplorer.js";

function Fixture({ priceError }: { priceError?: string }) {
  const [activeTab, setActiveTab] = useState<DashboardTab>(priceError ? "prices" : "events");
  return (
    <DataExplorer
      activeTab={activeTab}
      onTabChange={setActiveTab}
      priceError={priceError}
      renderPanel={(tab) => {
        if (tab === "projects") return <><label>Sort<select><option>Newest</option></select></label><span>Project A</span></>;
        if (tab === "prices") return <form aria-label="Model prices"><input value="gpt-5" readOnly /></form>;
        return <span>{tab === "events" ? "Event A" : "Device A"}</span>;
      }}
      t={(key) => key}
    />
  );
}

describe("DataExplorer", () => {
  afterEach(cleanup);

  test("keeps one data tablist and exposes the selected table workflow", () => {
    render(<Fixture />);
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Events" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
    expect(screen.getByLabelText("Sort")).toBeTruthy();
    expect(screen.getByText("Project A")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Prices" }));
    expect(screen.getByDisplayValue("gpt-5")).toBeTruthy();
  });

  test("renders a price mutation error in the selected price workflow", () => {
    render(<Fixture priceError="Failed to save model price" />);
    expect(screen.getByRole("alert").textContent).toBe("Failed to save model price");
  });
});
