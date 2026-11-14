import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard/src/index.css"), "utf8");

/** The custom properties declared in one rule, such as `:root` or `.dark`. */
function tokens(selector: string): Record<string, string> {
  const block = new RegExp(`(?:^|\\n)${selector.replace(/[.:]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

const luminance = (hex: string) => {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("the dashboard's scrollbars", () => {
  it("follow the app's own theme, not the system's: the page is light or dark by choice", () => {
    // `light dark` let a dark system put dark scrollbars and inputs on a light page.
    expect(/(^|\n)html\s*\{[^}]*color-scheme:\s*light;/.test(css)).toBe(true);
    expect(/(^|\n)\.dark\s*\{[^}]*color-scheme:\s*dark;/.test(css)).toBe(true);
    expect(css).not.toMatch(/color-scheme:\s*light dark/);
  });

  it("have a thumb colour and a hover colour in both themes", () => {
    for (const mode of [":root", ".dark"]) {
      const t = tokens(mode);
      expect(t["--scrollbar-thumb"]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t["--scrollbar-thumb-hover"]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("are never black, and can be found against the surfaces they sit on, in light and dark", () => {
    for (const mode of [":root", ".dark"]) {
      const t = tokens(mode);
      const thumb = t["--scrollbar-thumb"]!;
      const surface = t["--card"]!;
      expect([mode, luminance(thumb) > 0.03]).toEqual([mode, true]); // not black, or close to it, on a dark page either
      expect([mode, contrast(thumb, surface) >= 1.3]).toEqual([mode, true]);
      expect([mode, contrast(thumb, surface) <= 4]).toEqual([mode, true]); // and quiet, not a heavy bar
      // Hovering makes it stand out more, not less.
      expect([mode, contrast(t["--scrollbar-thumb-hover"]!, surface) > contrast(thumb, surface)]).toEqual([mode, true]);
    }
  });

  it("are thin and use those colours on every scrolling area, with a transparent track", () => {
    const rule = /(^|\n)\*\s*\{([^}]*)\}/.exec(css)?.[2] ?? "";
    expect(rule).toMatch(/scrollbar-width:\s*thin/);
    expect(rule).toMatch(/scrollbar-color:\s*var\(--scrollbar-thumb\)\s+transparent/);
  });

  it("look the same in browsers that do not know scrollbar-color", () => {
    const fallback = /@supports not \(scrollbar-color: auto\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(fallback).toContain("::-webkit-scrollbar-thumb");
    expect(fallback).toMatch(/background:\s*var\(--scrollbar-thumb\)/);
    expect(fallback).toMatch(/:hover\s*\{[^}]*var\(--scrollbar-thumb-hover\)/);
    expect(fallback).toMatch(/::-webkit-scrollbar-track[^{]*\{[^}]*background:\s*transparent/);
  });
});
