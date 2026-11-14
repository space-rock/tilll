// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tabs } from "../dashboard/src/components/ui/tabs.js";

afterEach(cleanup);

const OPTIONS = [
  { value: "all", label: "All" },
  { value: "waiting", label: "Waiting for approval", count: 2 },
  { value: "done", label: "Refunded", count: 0 },
];

describe("the tab bar", () => {
  it("scrolls sideways when the tabs do not fit, never up and down, and shows no scrollbar", () => {
    render(<Tabs label="Filter" value="all" options={OPTIONS} onChange={() => undefined} />);
    const classes = screen.getByRole("group", { name: "Filter" }).className.split(/\s+/);
    // overflow-x alone makes the browser treat overflow-y as auto, so a tab poking out below the bar showed a scrollbar.
    expect(classes).toContain("overflow-x-auto");
    expect(classes).toContain("overflow-y-hidden");
    expect(classes).toContain("[scrollbar-width:none]");
    expect(classes).toContain("[&::-webkit-scrollbar]:hidden");
  });

  it("keeps every tab inside the bar: nothing is pulled below it with a negative margin", () => {
    render(<Tabs label="Filter" value="all" options={OPTIONS} onChange={() => undefined} />);
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).not.toMatch(/(^|\s)-m[bt]-/);
    }
    // The tab source itself must not bring the negative margin back either.
    expect(readFileSync(join(process.cwd(), "dashboard/src/components/ui/tabs.tsx"), "utf8")).not.toMatch(
      /["'\s]-mb-px/,
    );
  });

  it("marks the chosen tab with an underline drawn inside the tab, and says which is pressed", () => {
    render(<Tabs label="Filter" value="waiting" options={OPTIONS} onChange={() => undefined} />);
    const chosen = screen.getByRole("button", { name: /Waiting for approval/ });
    expect(chosen.getAttribute("aria-pressed")).toBe("true");
    expect(chosen.className).toContain("shadow-[inset_0_-2px_0_0_var(--color-primary)]");
    const other = screen.getByRole("button", { name: "All" });
    expect(other.getAttribute("aria-pressed")).toBe("false");
    expect(other.className).not.toContain("inset_0_-2px");
  });

  it("shows a count only when there is something to count, and tells the page when a tab is chosen", () => {
    const onChange = vi.fn<(value: string) => void>();
    render(<Tabs label="Filter" value="all" options={OPTIONS} onChange={onChange} />);
    expect(screen.getByRole("button", { name: /Waiting for approval/ }).textContent).toContain("2");
    expect(screen.getByRole("button", { name: "Refunded" }).textContent).toBe("Refunded"); // a count of 0 is left out
    fireEvent.click(screen.getByRole("button", { name: "Refunded" }));
    expect(onChange).toHaveBeenCalledWith("done");
  });
});
