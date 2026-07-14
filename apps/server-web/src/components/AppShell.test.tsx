// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AppShell } from "./AppShell.js";

const defaultProps = {
  activeSection: "overview" as const,
  adminEmail: "admin@example.com",
  currentTimeLabel: "2026-07-14 10:30:00 UTC",
  languageSetting: "en" as const,
  loading: false,
  theme: "light" as const,
  t: (key: string) => key,
  onLanguageChange: vi.fn(),
  onLogout: vi.fn(),
  onNavigate: vi.fn(),
  onOpenPrices: vi.fn(),
  onRefresh: vi.fn(),
  onThemeToggle: vi.fn()
};

describe("AppShell", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test("uses page-level navigation without duplicating data tabs", () => {
    render(<AppShell {...defaultProps}>Dashboard content</AppShell>);

    fireEvent.click(screen.getByRole("button", { name: "Usage trend" }));
    expect(defaultProps.onNavigate).toHaveBeenCalledWith("trend");

    fireEvent.click(screen.getByRole("button", { name: "Model prices" }));
    expect(defaultProps.onOpenPrices).toHaveBeenCalledOnce();
    expect(screen.queryByRole("tab", { name: "Events" })).toBeNull();
  });

  test("opens and closes the mobile navigation after a destination is chosen", () => {
    render(<AppShell {...defaultProps}>Dashboard content</AppShell>);

    const navigation = screen.getByRole("navigation", { name: "Dashboard navigation" });
    expect(navigation.getAttribute("data-mobile-open")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(navigation.getAttribute("data-mobile-open")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Data explorer" }));
    expect(defaultProps.onNavigate).toHaveBeenCalledWith("explorer");
    expect(navigation.getAttribute("data-mobile-open")).toBe("false");
  });
});
