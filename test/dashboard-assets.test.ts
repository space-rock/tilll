import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const files = (dir: string, extensions: string[]): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path, extensions);
    return extensions.some((e) => entry.name.endsWith(e)) ? [path] : [];
  });

/** The text of a source file without its comments, which may name things the screen does not. */
const withoutComments = (file: string) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Whether a file imports `name`, statically or with `import()`. A comment that only names it does not count. */
const importsLibrary = (file: string, name: string) =>
  new RegExp(`(from\\s+|import\\()\\s*["']${name.replace(/[/@]/g, "\\$&")}["']`).test(withoutComments(file));

const dashboardSources = files("dashboard/src", [".ts", ".tsx"]);
const dashboardComponents = dashboardSources.filter((f) => f.endsWith(".tsx"));
const dashboardCss = read("dashboard/src/index.css");

describe("the dashboard's fonts", () => {
  const faces = [...dashboardCss.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)].map((m) => m[1]!);

  it("are three variable fonts, each served from a file in this repository", () => {
    expect(faces).toHaveLength(3);
    for (const face of faces) {
      const url = /url\("([^"]+)"\)/.exec(face)?.[1];
      expect([face, url !== undefined]).toEqual([face, true]);
      expect(url).not.toMatch(/^(https?:)?\/\//);
      expect([url, existsSync(join(root, "dashboard/src", url!))]).toEqual([url, true]);
      expect(face).toMatch(/font-display:\s*swap/);
      expect(face).toMatch(/woff2-variations/);
    }
  });

  it("are the ones the tokens name, so the page never falls back to a font it did not load", () => {
    for (const family of ["Inter Variable", "Manrope Variable", "JetBrains Mono Variable"]) {
      expect(dashboardCss).toContain(`font-family: "${family}"`);
      expect(dashboardCss).toMatch(new RegExp(`--font-[a-z]+:[^;]*"${family}"`));
    }
  });

  it("load nothing from another host: no remote @import, no remote url()", () => {
    expect(dashboardCss).not.toMatch(/@import\s+url\(["']?https?:/);
    expect(dashboardCss).not.toMatch(/url\(["']?(https?:)?\/\//);
    expect(dashboardCss).not.toMatch(/fonts\.(googleapis|gstatic)/);
  });

  it("are Latin subsets, which is all an English dashboard needs", () => {
    for (const face of faces) expect(face).toMatch(/-latin-wght-normal\.woff2/);
  });
});

describe("the wallet library", () => {
  it("is imported by one file in the dashboard, and only as a dynamic import, so it is a separate download", () => {
    const users = dashboardSources.filter((f) => importsLibrary(f, "@hot-labs/near-connect"));
    expect(users).toEqual(["dashboard/src/wallet.tsx"]);
    const wallet = withoutComments("dashboard/src/wallet.tsx");
    expect(wallet).toContain('import("@hot-labs/near-connect")');
    // The one static mention is a type, which is erased.
    expect(wallet).not.toMatch(/^import\s+\{(?!\s*type)[^}]*\}\s+from\s+["']@hot-labs\/near-connect["']/m);
  });

  it("is never imported by the checkout widget, the server, or the hosted pay page", () => {
    const sources = [...files("widget/src", [".ts", ".tsx"]), ...files("src", [".ts", ".tsx"])];
    const offenders = sources.filter(
      (file) => importsLibrary(file, "@hot-labs/near-connect") || importsLibrary(file, "lucide-react"),
    );
    expect(offenders).toEqual([]);
  });

  it("is pinned to one exact version, like the icon library", () => {
    const pkg = JSON.parse(read("package.json")) as { devDependencies: Record<string, string> };
    for (const name of ["@hot-labs/near-connect", "lucide-react"]) {
      expect([name, /^\d+\.\d+\.\d+$/.test(pkg.devDependencies[name] ?? "")]).toEqual([name, true]);
    }
  });
});

describe("the dashboard's icons", () => {
  it("come from one library that ships inline SVG, not an icon font", () => {
    const offenders = dashboardComponents.filter((f) =>
      /fontawesome|material-icons|<i className="(fa|icon)/i.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });
});

describe("the dashboard's voice", () => {
  it("has dropped the jargon and chatty labels the redesign replaced", () => {
    const banned = [
      /Intents contract/,
      /1Click (connected|unreachable|quote)/,
      /Nothing sent yet/,
      /Select an invoice/,
      /Confirm refund/,
      /Refund this payment/,
      /Will try again/,
      /Log in with your merchant secret/,
      /Read-only\. Change these/,
      // One name for each thing (see NOTES.md, copy pass): these were the second names.
      /Largest single refund/,
      /Most refunded per day/,
      /Returned by NEAR Intents/,
      /Superseded/,
      /Payment attempts/,
      /Hosted payment page/,
      /\bpay links?\b/i,
      /Refund payment/,
      /Confirm with wallet/,
      /Deposit address/,
      /Invoice id\b/,
      /\b(could not|did not|does not|cannot)\b/i,
    ];
    const found = dashboardComponents.flatMap((file) =>
      banned.filter((rule) => rule.test(withoutComments(file))).map((rule) => `${file}: ${rule.source}`),
    );
    expect(found).toEqual([]);
  });

  it("has no exclamation marks in what it says", () => {
    const found = dashboardComponents.flatMap((file) =>
      // The words between tags: they start with a letter and hold no code punctuation.
      [...withoutComments(file).matchAll(/(?<![=-])>([A-Za-z][^<>{}()=;]*)</g)]
        .map((m) => m[1]!.trim())
        .filter((text) => text.includes("!"))
        .map((text) => `${file}: ${text}`),
    );
    expect(found).toEqual([]);
  });

  it("names the settlement account and asset the way the docs do", () => {
    const settings = read("dashboard/src/pages/Settings.tsx");
    for (const term of ["Settlement account", "Settlement asset", "Verifier contract"])
      expect(settings).toContain(term);
  });
});

const built = join(root, "public/dashboard");

describe.skipIf(!existsSync(built))("the built dashboard", () => {
  it("loads its fonts from its own assets, and the wallet library from a separate file", () => {
    const assets = readdirSync(join(built, "assets"));
    expect(assets.filter((a) => a.endsWith(".woff2"))).toHaveLength(3);
    const entry = assets.find((a) => /^index-.*\.js$/.test(a))!;
    const main = readFileSync(join(built, "assets", entry), "utf8");
    // The entry script does not carry the wallet library: it imports its chunk only on demand.
    expect(main).not.toContain("raw.githubusercontent.com");
    expect(main).not.toContain("cdn.jsdelivr.net");
    const chunks = assets.filter((a) => a.endsWith(".js") && a !== entry);
    const walletChunks = chunks.filter((a) =>
      readFileSync(join(built, "assets", a), "utf8").includes("raw.githubusercontent.com"),
    );
    expect(walletChunks).toHaveLength(1);
  });

  it("has no remote font or stylesheet link", () => {
    const html = readFileSync(join(built, "index.html"), "utf8");
    expect(html).not.toMatch(/(href|src)="https?:/);
    const builtCss = readdirSync(join(built, "assets"))
      .filter((a) => a.endsWith(".css"))
      .map((a) => readFileSync(join(built, "assets", a), "utf8"))
      .join("\n");
    expect(builtCss).not.toMatch(/fonts\.(googleapis|gstatic)/);
  });
});
