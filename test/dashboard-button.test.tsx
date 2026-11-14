// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "../dashboard/src/components/ui/button.js";

afterEach(cleanup);

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "src");
const css = readFileSync(join(root, "index.css"), "utf8");

/** The `--name: value` declarations of one block of index.css, such as `:root` or `.dark`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  const block = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, bl] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
}

/** WCAG contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("Button", () => {
  it("is navy with white text, and shows hover, pressed and disabled states in colour, not by fading", () => {
    render(<Button>Create invoice</Button>);
    const classes = screen.getByRole("button").className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining([
        "bg-primary",
        "text-primary-foreground",
        "hover:bg-primary-hover",
        "active:bg-primary-active",
        "disabled:bg-disabled",
        "disabled:text-disabled-foreground",
        "disabled:cursor-not-allowed",
      ]),
    );
    expect(classes.filter((c) => /opacity/.test(c))).toEqual([]);
  });

  it.each(["outline", "ghost", "danger"] as const)("gives the %s look its own hover and pressed colour", (variant) => {
    render(<Button variant={variant}>Go</Button>);
    const classes = screen.getByRole("button").className;
    expect(classes).toMatch(/hover:bg-/);
    expect(classes).toMatch(/active:bg-/);
    expect(classes).toMatch(/disabled:text-disabled-foreground/);
    expect(classes).not.toMatch(/opacity/);
  });

  it("cannot be pressed while disabled", () => {
    const onClick = vi.fn<() => void>();
    render(
      <Button disabled onClick={onClick}>
        Confirm refund
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Confirm refund" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("the dashboard's colours", () => {
  it("keeps green out of every button and link: the brand look is gone, and emerald marks status only", () => {
    expect(readFileSync(join(root, "components", "ui", "button.tsx"), "utf8")).not.toMatch(/brand/);
    const files = (dir: string): string[] =>
      readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
      );
    const used = files(".").flatMap((file) =>
      readFileSync(join(root, file), "utf8")
        .split("\n")
        .filter((line) => /variant="brand"|text-brand|brand-dark|brand-light/.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(used).toEqual([]);
  });

  it("sets the navy button, in light and dark, and its hover, pressed and disabled colours", () => {
    expect(tokens(":root")).toMatchObject({
      primary: "#0b1f3a",
      "primary-foreground": "#ffffff",
      "primary-hover": "#1e3a5f",
      "primary-active": "#071426",
      disabled: "#e2e8f0",
      "disabled-foreground": "#94a3b8",
      ring: "#6366f1",
    });
    expect(tokens(".dark")).toMatchObject({
      primary: "#2b4c7e",
      "primary-foreground": "#ffffff",
      "primary-hover": "#345c96",
      disabled: "#27272a",
      "disabled-foreground": "#71717a",
      ring: "#818cf8",
    });
  });

  it("keeps white text on the button readable (4.5:1) and the focus ring visible (3:1), in light and dark", () => {
    for (const mode of [":root", ".dark"]) {
      const t = tokens(mode);
      for (const bg of ["primary", "primary-hover", "primary-active", "danger-solid", "danger-solid-hover"]) {
        const colour = t[bg] ?? tokens(":root")[bg]!;
        expect([mode, bg, contrast("#ffffff", colour) >= 4.5]).toEqual([mode, bg, true]);
      }
      expect([mode, contrast(t["ring"]!, t["background"]!) >= 3]).toEqual([mode, true]);
    }
  });
});
