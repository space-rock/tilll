import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyLinks, parseLinks, type SiteLinks } from "../site/links.js";
import { STRICT_CHAINS } from "../src/validate/addresses.js";
import { thrownBy } from "./helpers/failure.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name: string) => readFileSync(join(root, name), "utf8");
const source = read("site/index.html");
const readme = read("README.md");

const NO_LINKS: SiteLinks = { github: null, demoVideo: null };
const LINKS: SiteLinks = { github: "https://github.com/owner/tilll", demoVideo: "https://video.example/tilll" };
const page = (links: SiteLinks = NO_LINKS) => applyLinks(source, links);

/** The page's text, as a reader sees it: no tags, no code blocks, no illustrations. */
const prose = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<pre[\s\S]*?<\/pre>/g, " ")
    .replace(/<figure data-illustration[\s\S]*?<\/figure>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ");

/** The number of words in a piece of text. */
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** One `<section>` of the page, by id. */
const section = (id: string, html = page()) =>
  new RegExp(`<section\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?</section>`).exec(html)?.[0] ?? "";

/** GitHub's anchor for a README heading. */
const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replaceAll(" ", "-");
const readmeAnchors = new Set([...readme.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]!.trim())));

/** The text of a code sample on the page, as someone copying it would get it. */
const codeBlock = (id: string) => {
  const match = new RegExp(`<pre\\s+id="${id}"[^>]*>\\s*<code>([\\s\\S]*?)</code></pre>`).exec(page(LINKS));
  return (match?.[1] ?? "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
};

describe("site links", () => {
  it("accepts https links and null, and strips a trailing slash", () => {
    expect(parseLinks({ github: "https://github.com/owner/tilll/", demoVideo: null })).toEqual({
      github: "https://github.com/owner/tilll",
      demoVideo: null,
    });
    expect(parseLinks({})).toEqual(NO_LINKS);
  });

  it.each([
    "javascript:alert(1)",
    "http://github.com/x",
    "//github.com/x",
    "github.com/x",
    7,
    "https://x.com/a b",
    'https://x.com/"onclick="x',
  ])("refuses %j, so a link can never be a script or a plain-http page", (bad) => {
    expect(() => parseLinks({ github: bad })).toThrow(/https URL/);
  });

  it("removes the buttons whose link does not exist yet, and leaves no dead link or placeholder behind", () => {
    const html = page();
    expect(html).not.toMatch(/data-needs|\{\{|github\.com|href=""/);
    expect(html).not.toMatch(/>\s*(GitHub|View on GitHub|Watch the demo|Source|Demo video)\s*</);
    expect(html).toContain("&lt;repository-url&gt;");
  });

  it("shows them, pointing at the real links, once they exist", () => {
    const html = page(LINKS);
    expect(html).not.toMatch(/data-needs|\{\{/);
    const repoLinks = [...html.matchAll(/href="(https:\/\/github\.com\/[^"]*)"/g)].map((m) => m[1]!);
    expect(repoLinks.length).toBeGreaterThanOrEqual(5);
    for (const link of repoLinks) expect(link).toMatch(/^https:\/\/github\.com\/owner\/tilll(#[a-z0-9-]+)?$/);
    expect(html).toContain('href="https://video.example/tilll"');
    expect(html).toContain("git clone https://github.com/owner/tilll tilll");
  });

  it("points every README link at a heading that exists in the README", () => {
    const anchors = [...page(LINKS).matchAll(/href="https:\/\/github\.com\/owner\/tilll#([a-z0-9-]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(anchors.length).toBeGreaterThanOrEqual(4);
    expect(anchors.filter((a) => !readmeAnchors.has(a))).toEqual([]);
  });

  it("keeps the demo video link out while only the repository is public", () => {
    const html = page({ github: LINKS.github, demoVideo: null });
    expect(html).toContain("View on GitHub");
    expect(html).not.toMatch(/Watch the demo|Demo video/);
  });

  it("fails the build on a placeholder it does not know, and on an unknown data-needs", () => {
    expect(thrownBy(Error, () => applyLinks("<p>{{nope}}</p>", NO_LINKS)).message).toMatch(/\{\{nope\}\}/);
    expect(thrownBy(Error, () => applyLinks('<a data-needs="twitter" href="x">x</a>', NO_LINKS)).message).toMatch(
      /twitter/,
    );
  });

  it("copes with a closing tag split over lines", () => {
    const html = '<a data-needs="github" href="{{github}}"\n  >Go</a\n>after';
    expect(applyLinks(html, NO_LINKS)).toBe("after");
  });

  it("ships links.json with nothing filled in yet (PLAN section 21: Phase 9)", () => {
    expect(parseLinks(JSON.parse(read("site/links.json")))).toEqual(NO_LINKS);
  });
});

describe("the project site", () => {
  it("has its sections in order, and none about the technology underneath or about why to self-host", () => {
    const html = page();
    const order = [
      "<header",
      'id="top"',
      'id="values"',
      'id="how"',
      'id="features"',
      'id="developers"',
      'id="self-host"',
      "<footer",
    ];
    const at = order.map((marker) => html.indexOf(marker));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual(at.toSorted((a, b) => a - b));
    for (const gone of ["why", "depends", "payments", "refunds"]) expect(html).not.toContain(`id="${gone}"`);
  });

  it("opens with the outcome, names NEAR Intents once, and offers the two buttons", () => {
    const hero = prose(section("top"));
    expect(hero).toContain("Open source · Self-hosted");
    expect(hero).toContain("Get paid in crypto, from any chain.");
    expect(hero).toContain("Free, open source, self-hosted. Powered by NEAR Intents.");
    expect(hero).toContain("Self-host in 5 minutes");
    expect(prose(section("top", page(LINKS)))).toContain("View on GitHub");
    expect(hero).not.toMatch(/refund/i);
    expect(page()).toMatch(/<a href="#self-host" class="btn btn-primary">Self-host in 5 minutes<\/a>/);
  });

  it("states four values in a few words each, and the README has the matching step for each", () => {
    const values = section("values");
    expect([...values.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1]!.trim())).toEqual([
      "Self-hosted",
      "Open source",
      "Private",
      "Secure",
    ]);
    const text = prose(values);
    expect(text).toMatch(/Runs on your server/);
    expect(text).toMatch(/MIT licensed/);
    expect(text).toMatch(/no name, email or account/);
    expect(text).toMatch(/Your keys never leave your server/);
    expect(readme).toMatch(/^## Privacy$/m);
    expect(readme).toContain("test/privacy.test.ts");
    expect(readme).toContain("docker compose up --build");
    expect(readme).toContain("pnpm test");
  });

  it("keeps refunds as one feature, with the price caveat the README gives", () => {
    const features = prose(section("features"));
    expect(features).toContain("Refunds return the value at today's price");
    expect(features).toMatch(/Duplicate and late payments/);
    expect(readme).toContain("Refunds return the value at today's price");
  });

  it("is short: a few words per tile, and a small page", () => {
    const html = page();
    const sub = /Free, open source, self-hosted\. Powered by NEAR Intents\./.exec(prose(html))?.[0] ?? "";
    expect(words(sub)).toBeLessThanOrEqual(12);
    const tiles = [...html.matchAll(/<p class="mt-2[^"]*">([\s\S]*?)<\/p>/g)].map((m) => prose(m[1]!));
    expect(tiles.length).toBeGreaterThanOrEqual(13);
    for (const tile of tiles) expect([tile, words(tile) <= 16]).toEqual([tile, true]);
    expect(words(prose(html))).toBeLessThanOrEqual(330);
  });

  it("talks to users, not about the technology: no jargon, no 1Click, no asset, no cookie line", () => {
    const text = prose(page()).replaceAll("NEAR Intents", "");
    const found =
      /1Click|USDC|SQLite|HMAC|\bNEP|shadow|\bRPC|JSON|idempotent|\bintents?\b|confidential|censor|hackathon|cookie/i.exec(
        text,
      );
    expect(found?.[0]).toBeUndefined();
  });

  it("names NEAR Intents in the hero and the footer, and nowhere else", () => {
    const html = page();
    expect(prose(section("top"))).toContain("NEAR Intents");
    const footer = /<footer[\s\S]*<\/footer>/.exec(html)?.[0] ?? "";
    expect(prose(footer)).toContain("MIT licensed · Powered by NEAR Intents");
    const rest = prose(html.replace(section("top"), "").replace(footer, ""));
    expect(rest).not.toContain("NEAR Intents");
  });

  it("has a title and a description that match the headline", () => {
    const html = page();
    expect(html).toMatch(/<title>Tilll · Get paid in crypto, from any chain<\/title>/);
    expect(html).toMatch(/<meta\s+name="description"\s+content="[^"]{60,}"/);
  });

  it("makes no claim about who uses it, and shows no metric, testimonial or partner logo", () => {
    const text = prose(page());
    expect(text).not.toMatch(
      /trusted by|testimonial|loved by|used by|partners?\b|as seen|customers love|case study|audited/i,
    );
    expect(text).not.toMatch(/\b\d[\d,.]*\s?(\+|k\b|m\b|%|users|merchants|customers|transactions|volume)/i);
    expect(page()).not.toMatch(/<img[^>]*(logo|partner|customer)/i);
  });

  it("offers only chains the checkout really takes, by their own check", () => {
    const codes: Record<string, string> = {
      Ethereum: "eth",
      Base: "base",
      Arbitrum: "arb",
      Optimism: "op",
      Polygon: "pol",
      "BNB Chain": "bsc",
      Avalanche: "avax",
      Solana: "sol",
      NEAR: "near",
      Bitcoin: "btc",
      Tron: "tron",
    };
    const chips = [...page().matchAll(/<li data-chip[^>]*>([^<]+)<\/li>/g)].map((m) => m[1]!.trim());
    expect(chips.length).toBeGreaterThanOrEqual(8);
    for (const chip of chips) {
      expect(codes[chip], `${chip} is not a chain the checkout knows`).toBeDefined();
      expect(STRICT_CHAINS).toContain(codes[chip]);
    }
  });

  describe("what it tells a developer to type", () => {
    it("is the same embed snippet as the README", () => {
      const snippet = codeBlock("embed");
      expect(snippet).toContain('<script src="https://pay.example.com/checkout.js"></script>');
      expect(snippet).toContain('<button data-tilll-invoice="inv_...">Pay with crypto</button>');
      for (const line of snippet.split("\n")) expect(readme).toContain(line);
    });

    it("creates an invoice with a route and a body that exist", () => {
      const curl = codeBlock("curl");
      expect(curl).toContain("/v1/invoices");
      expect(curl).toMatch(/Authorization: Bearer \$MERCHANT_SECRET/);
      expect(curl).toContain('{"amount":"5.00"');
      expect(readme).toMatch(/\| POST \| `\/v1\/invoices` \|/);
    });

    it("is the setup the README Quick start gives, in the same order", () => {
      const lines = codeBlock("setup").split("\n").filter(Boolean);
      expect(lines).toEqual([
        "git clone https://github.com/owner/tilll tilll && cd tilll",
        "pnpm install",
        "pnpm tilll init",
        "docker compose up --build",
      ]);
      const quick = readme.slice(readme.indexOf("## Quick start"), readme.indexOf("## What is verified"));
      for (const command of lines.slice(1)) expect(quick).toContain(command);
      expect(quick.indexOf("pnpm install")).toBeLessThan(quick.indexOf("pnpm tilll init"));
      expect(quick.indexOf("pnpm tilll init")).toBeLessThan(quick.indexOf("docker compose up --build"));
      expect(page(LINKS)).toContain("http://localhost:8080/dashboard");
      expect(quick).toContain("http://localhost:8080/dashboard");
    });
  });
});

describe("the landing page's markup", () => {
  const html = page(LINKS);

  it("has every in-page link pointing at something on the page, and no link that goes nowhere", () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
    const anchors = [...html.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]!);
    expect(anchors.length).toBeGreaterThan(5);
    expect(anchors.filter((id) => !ids.has(id))).toEqual([]);
    expect(html).not.toMatch(/href="#?"/);
  });

  it("gives every image a text alternative, and has exactly one h1", () => {
    for (const tag of html.match(/<img\b[^>]*>/g) ?? []) expect(tag).toMatch(/\balt="/);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });

  it("labels its sections and its navigation for screen readers", () => {
    expect(html).not.toContain("<table");
    for (const tag of html.match(/<nav\b[^>]*>/g) ?? []) expect(tag).toMatch(/aria-label="/);
    for (const tag of html.match(/<section\b[^>]*>/g) ?? []) expect(tag).toMatch(/aria-labelledby="/);
    expect(html).toMatch(/href="#main"/);
  });

  it("needs no inline script, inline style or event handler, which its Content-Security-Policy forbids", () => {
    const withoutBlocks = html.replace(/<script[^>]*src=[^>]*><\/script>/g, "");
    expect(withoutBlocks).not.toMatch(/<script\b/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/<style\b/);
  });

  it("loads nothing from anywhere but itself, and links out only to the NEAR Intents docs and its own project links", () => {
    // Code samples in <pre> show example URLs as text; only real attributes count.
    const markup = html.replace(/<pre[\s\S]*?<\/pre>/g, "");
    const urls = [...markup.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)].map((m) => new URL(m[1]!).hostname);
    const allowed = new Set(["docs.near-intents.org", "github.com", "video.example"]);
    expect(urls.filter((host) => !allowed.has(host))).toEqual([]);
    for (const tag of markup.match(/<(?:script|link|img)\b[^>]*>/g) ?? [])
      expect(tag).not.toMatch(/(?:src|href)="https?:/);
    expect(markup).not.toMatch(/googleapis|gstatic|cdn\./i);
  });

  it("draws every button and button-like link from one navy set, with no green button", () => {
    const controls = html.match(/<(?:a|button)\b[^>]*\bclass="[^"]*\bbtn\b[^"]*"[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThanOrEqual(6);
    for (const tag of controls) {
      expect(tag).toMatch(/\bbtn-(primary|secondary|inverse|outline-inverse)\b/);
      expect(tag).not.toMatch(/bg-(brand|mint|emerald)|text-(brand|mint)/);
    }
    // Nothing is a button without the shared class.
    for (const tag of html.match(/<button\b[^>]*>/g) ?? []) expect(tag).toMatch(/\bbtn\b/);
  });

  it("carries its own Content-Security-Policy, because a static host sends none", () => {
    const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
    expect(meta).toBeDefined();
    const policy = new Map(
      meta!
        .split(";")
        .map((d) => d.trim().split(/\s+/) as [string, ...string[]])
        .map(([k, ...v]) => [k, v.join(" ")]),
    );
    expect(Object.fromEntries(policy)).toEqual({
      "default-src": "'none'",
      "script-src": "'self'",
      "style-src": "'self'",
      "img-src": "'self' data:",
      "font-src": "'self'",
      "connect-src": "'none'",
      "base-uri": "'none'",
      "form-action": "'none'",
    });
  });

  it("opens outside links safely", () => {
    for (const tag of html.replace(/<pre[\s\S]*?<\/pre>/g, "").match(/<a\b[^>]*href="https?:[^>]*>/g) ?? []) {
      expect(tag).toMatch(/rel="noopener"/);
    }
  });
});

describe("the project site's button styles", () => {
  const css = read("site/src/site.css").replace(/\s+/g, " ");
  const rule = (selector: string) =>
    new RegExp(`${selector.replace(/[.:[\]="()]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "i").exec(css)?.[1] ?? "";

  it("makes the primary button navy with white text, and gives it a hover, a pressed and a disabled state", () => {
    expect(css).toMatch(/--color-navy:\s*#0b1f3a/i);
    expect(css).toMatch(/--color-navy-soft:\s*#1e3a5f/i);
    expect(css).toMatch(/--color-navy-deep:\s*#071426/i);
    expect(rule(".btn-primary")).toMatch(/background-color:\s*var\(--color-navy\)/);
    expect(rule(".btn-primary")).toMatch(/color:\s*#fff/);
    expect(rule(".btn-primary:hover")).toMatch(/var\(--color-navy-soft\)/);
    expect(rule(".btn-primary:active")).toMatch(/var\(--color-navy-deep\)/);
  });

  it("greys a disabled button out and shows that it cannot be pressed", () => {
    expect(rule('.btn:disabled, .btn[aria-disabled="true"]')).toMatch(/cursor:\s*not-allowed/);
    expect(rule('.btn-primary:disabled, .btn-primary[aria-disabled="true"]')).toMatch(/#e2e8f0/i);
    expect(rule('.btn-primary:disabled, .btn-primary[aria-disabled="true"]')).toMatch(/#94a3b8/i);
  });

  it("has a version for navy backgrounds, and a visible focus ring on light and dark", () => {
    expect(rule(".btn-inverse")).toMatch(/background-color:\s*#fff/);
    expect(rule(".btn-inverse:hover")).toMatch(/#e2e8f0/i);
    expect(css).toMatch(/--color-ring:\s*#6366f1/i);
    expect(css).toMatch(/--color-ring-soft:\s*#818cf8/i);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-ring\)/);
    expect(css).toMatch(/\.on-dark[^{]*:focus-visible\s*\{[^}]*var\(--color-ring-soft\)/);
  });
});

const policyOf = (markup: string) =>
  /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(markup)?.[1];

/** The field names of a zod object schema declared in the merchant routes. */
const routeSchemaFields = (name: string) => {
  const body =
    new RegExp(`const ${name} = z\\.object\\(\\{([\\s\\S]*?)\\n\\}\\);`).exec(read("src/routes/merchant.ts"))?.[1] ??
    "";
  return [...body.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]!);
};

describe("the docs page", () => {
  const docsSource = read("site/docs.html");
  const docs = (links: SiteLinks = NO_LINKS) => applyLinks(docsSource, links);
  const html = docs(LINKS);
  const envExample = read(".env.example");
  const docsCode = (id: string) => {
    const match = new RegExp(`<pre\\s+id="${id}"[^>]*>\\s*<code>([\\s\\S]*?)</code></pre>`).exec(html);
    return (match?.[1] ?? "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  };
  const docsSection = (id: string) => section(id, html);
  const docsText = prose(html.replace(/<footer[\s\S]*<\/footer>/, "").replace(/<header[\s\S]*?<\/header>/, ""));

  it("is built next to the landing page, which links to it", () => {
    const config = read("site/vite.config.ts");
    expect(config).toContain("./index.html");
    expect(config).toContain("./docs.html");
    expect(page(LINKS)).toContain('href="./docs.html"');
    expect(html).toContain('href="./"');
    expect(readme).toContain("docs.html");
  });

  it("is organised by task, in order, and each section opens with a sentence of its own", () => {
    const order = [
      "overview",
      "quickstart",
      "accept",
      "webhooks",
      "refunds",
      "security",
      "go-live",
      "configuration",
      "api",
      "privacy",
    ];
    const at = order.map((id) => html.indexOf(`<section id="${id}"`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual(at.toSorted((a, b) => a - b));
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    // The sidebar lists every section.
    const toc = /<nav aria-label="On this page"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
    expect([...toc.matchAll(/href="#([^"]+)"/g)].map((m) => m[1])).toEqual(order);
    // Every section starts with an h2 and then a paragraph, never a list or a code block.
    for (const id of order) {
      expect(docsSection(id)).toMatch(/<h2\b[\s\S]*?<\/h2>\s*(?:<p\b|<div class="mt-6)/);
    }
  });

  it("lets the merchant choose the settlement asset, and never says they are paid in USDC", () => {
    expect(docsText).not.toMatch(/(paid|receive|settle[sd]?)\s+(in\s+)?USDC/i);
    expect(docsText).not.toMatch(/\bin USDC\b/);
    expect(docsText).toMatch(/the settlement asset you choose/i);
    const row = /<dt>\s*<code>SETTLEMENT_ASSET_ID<\/code>[\s\S]*?<\/dd>/.exec(docsSection("configuration"))?.[0] ?? "";
    expect(prose(row)).toMatch(/Default: USDC on NEAR/);
    expect(prose(row)).toMatch(/any asset id that the 1Click API lists/);
    const refunds = prose(docsSection("configuration"));
    expect(refunds).toMatch(/REFUND_MAX_PER_TX.*in settlement asset units/);
    expect(refunds).toMatch(/REFUND_MAX_PER_DAY.*in settlement asset units/);
    // Where the README names USDC for the settlement asset, it calls it the default.
    expect(readme).not.toMatch(/you receive USDC/);
    expect(readme).toMatch(/the asset you choose \(USDC on NEAR by default\)/);
  });

  it("describes its own product only: no comparison with other payment products", () => {
    expect(docsText).not.toMatch(
      /other (payment )?(buttons|providers|products|processors|gateways)|some payment|unlike |only meant for tips|tips and donations|btcpay|stripe|paypal|coinbase/i,
    );
    const security = readme.slice(readme.indexOf("### Integration security"), readme.indexOf("## Configuration"));
    expect(security).not.toMatch(/other (payment )?(buttons|providers)|some payment|tips|btcpay|stripe/i);
  });

  it("keeps a plain, professional tone: no chatty phrasing", () => {
    expect(docsText).not.toMatch(
      /good to know|no page of your own|a buyer|buyers|five minutes, and|you will be|let's|just |simply|easy|magic/i,
    );
    expect(docsText).not.toMatch(/!/);
  });

  it("gives the setup the README Quick start gives", () => {
    const lines = docsCode("setup").split("\n").filter(Boolean);
    expect(lines).toEqual([
      "git clone https://github.com/owner/tilll tilll && cd tilll",
      "pnpm install",
      "pnpm tilll init",
      "docker compose up --build",
    ]);
    const quick = readme.slice(readme.indexOf("## Quick start"), readme.indexOf("## What is verified"));
    for (const command of lines.slice(1)) expect(quick).toContain(command);
    const missing = docsCode("check")
      .split("\n")
      .filter(Boolean)
      .filter((command) => !readme.includes(command.split(" --")[0]!));
    expect(missing).toEqual([]);
    expect(html).toContain("http://localhost:8080/dashboard");
  });

  it("uses the same embed snippet as the README", () => {
    const snippet = docsCode("embed");
    expect(snippet).toContain('<script src="https://pay.example.com/checkout.js"></script>');
    for (const line of snippet.split("\n")) expect(readme).toContain(line);
    for (const attribute of ["data-tilll-invoice", "data-tilll-inline", "Tilll.open"])
      expect(readme).toContain(attribute);
  });

  it("creates the invoice with a route and a body that exist, taking the price from the server", () => {
    const code = docsCode("create");
    expect(code).toContain("/v1/invoices");
    expect(code).toMatch(/Authorization: `Bearer \$\{process\.env\.MERCHANT_SECRET\}`/);
    for (const field of ["amount", "description", "metadata"]) expect(code).toContain(`${field}:`);
    expect(code).toContain("never from the browser");
    expect(code).toContain("invoiceId: invoice.id");
  });

  it("documents exactly the fields the invoice and refund routes accept", () => {
    const fields = (id: string) =>
      [
        ...(new RegExp(`<dl data-params="${id}"[\\s\\S]*?</dl>`).exec(html)?.[0] ?? "").matchAll(
          /<dt>\s*<code>(\w+)<\/code>/g,
        ),
      ].map((m) => m[1]!);
    expect(fields("invoice").toSorted()).toEqual(routeSchemaFields("createInvoiceBody").toSorted());
    expect(fields("refund").toSorted()).toEqual(routeSchemaFields("refundBody").toSorted());
    // Required and optional are stated for each.
    const params = [...html.matchAll(/<dl data-params[\s\S]*?<\/dl>/g)].map((m) => prose(m[0])).join(" ");
    expect(params.match(/(Required|Optional)/g)).toHaveLength(6);
    expect(params).toMatch(/amount string · Required/);
    expect(params).toMatch(/idempotencyKey string · Required/);
  });

  it("states the limits the server enforces", () => {
    const service = read("src/invoices/service.ts");
    expect(service).toContain("DEFAULT_EXPIRY_MINUTES = 60");
    expect(service).toContain("MAX_EXPIRY_MINUTES = 7 * 24 * 60");
    expect(prose(docsSection("accept"))).toMatch(/from 1 to 10080.*Defaults to 60/);
    const merchant = read("src/routes/merchant.ts");
    expect(merchant).toContain("max(500)");
    expect(merchant).toContain("<= 4096");
    expect(prose(docsSection("accept"))).toMatch(/Up to 500 characters/);
    expect(prose(docsSection("accept"))).toMatch(/Up to 4 KB of JSON/);
    expect(merchant).toContain("max(200");
    expect(prose(docsSection("refunds"))).toMatch(/up to 200 characters/);
  });

  it("names only settings that exist in .env.example and the README", () => {
    const names = [...docsSection("configuration").matchAll(/<dt>\s*<code>([A-Z_]+)<\/code>/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThanOrEqual(12);
    expect(names.filter((name) => !new RegExp(`^${name}=`, "m").test(envExample))).toEqual([]);
    expect(names.filter((name) => !readme.includes(`\`${name}\``))).toEqual([]);
    // Each setting states its default, or says where its value comes from.
    for (const row of docsSection("configuration").match(/<dt>[\s\S]*?<\/dt>/g) ?? []) {
      expect(prose(row)).toMatch(/Default:|Generated by init|Optional/);
    }
  });

  it("lists only routes that the README documents, with the right method", () => {
    const routes = [
      ...docsSection("api").matchAll(
        /<li data-route[\s\S]*?<span data-method[^>]*>([A-Z]+)<\/span>\s*<code>([^<]+)<\/code>/g,
      ),
    ];
    expect(routes.length).toBeGreaterThanOrEqual(9);
    const missing = routes.filter(([, method, path]) => !readme.includes(`| ${method} | \`${path}\` |`));
    expect(missing.map((m) => `${m[1]} ${m[2]}`)).toEqual([]);
  });

  it("states the four security requirements, in the docs and in the README", () => {
    const rules = prose(docsSection("security"));
    expect(rules).toMatch(/Set amounts on your server/);
    expect(rules).toMatch(/Link each invoice to an order/);
    expect(rules).toMatch(/Fulfil from webhooks, not from client callbacks/);
    expect(rules).toMatch(/Keep secrets on your server/);
    expect(docsSection("security").match(/<li>/g)).toHaveLength(4);
    const security = readme.slice(readme.indexOf("### Integration security"), readme.indexOf("## Configuration"));
    expect(security.match(/^\d\. /gm)).toHaveLength(4);
    for (const rule of [
      "Set amounts on your server",
      "Link each invoice to an order",
      "Fulfil from webhooks",
      "Keep secrets on your server",
    ]) {
      expect(security).toContain(rule);
    }
    expect(readmeAnchors.has("integration-security")).toBe(true);
    expect(prose(docsSection("accept"))).toMatch(/Don't fulfil orders from onPaid/);
  });

  it("verifies a webhook the way the receiver does, and tells the reader what to check", () => {
    const code = docsCode("webhook");
    expect(code).toContain('createHmac("sha256"');
    expect(code).toContain("`${parts.t}.${rawBody}`");
    expect(code).toContain("timingSafeEqual");
    expect(code).toContain("<= 300");
    expect(code).toContain("tilll-signature");
    expect(code).toContain('event.type === "invoice.paid"');
    expect(read("demo-store/webhook-receiver.ts")).toContain("`${t}.${args.rawBody}`");
    const text = prose(docsSection("webhooks"));
    expect(text).toContain("Tilll-Signature: t=");
    expect(text).toContain("Tilll-Event-Id");
    expect(text).toMatch(/1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours/);
  });

  it("lists every event type Tilll sends, and no other", () => {
    const declared = [...read("src/events.ts").matchAll(/\|\s+"([a-z_.]+)"/g)].map((m) => m[1]!);
    expect(declared.length).toBe(10);
    const listed = [
      ...(/<dl data-events[\s\S]*?<\/dl>/.exec(html)?.[0] ?? "").matchAll(/<dt><code>([a-z_.]+)<\/code><\/dt>/g),
    ].map((m) => m[1]!);
    expect(listed).toEqual(declared);
    for (const type of declared) expect(readme).toContain(type);
  });

  it("shows an event whose shape carries the invoice id and amount", () => {
    const event = docsCode("event");
    expect(event).toContain('"type": "invoice.paid"');
    expect(event).toContain('"invoice": { "id"');
    expect(event).toContain('"proofVerified"');
  });

  it("points every README link at a heading that exists", () => {
    const anchors = [...html.matchAll(/href="https:\/\/github\.com\/owner\/tilll#([a-z0-9-]+)"/g)].map((m) => m[1]!);
    expect(anchors.length).toBeGreaterThanOrEqual(5);
    expect(anchors.filter((a) => !readmeAnchors.has(a))).toEqual([]);
  });

  it("has every in-page link pointing at something on the page, and no link that goes nowhere", () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
    const anchors = [...html.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]!);
    expect(anchors.length).toBeGreaterThan(10);
    expect(anchors.filter((id) => !ids.has(id))).toEqual([]);
    expect(html).not.toMatch(/href="#?"/);
  });

  it("removes the repository links until the repository is public", () => {
    const bare = docs();
    expect(bare).not.toMatch(/data-needs|\{\{|github\.com|href=""/);
    expect(bare).toContain("&lt;repository-url&gt;");
  });

  it("uses the landing page's security rules: its own CSP, no inline script, style or handler, labelled navigation", () => {
    expect(policyOf(html)).toBeDefined();
    expect(policyOf(html)).toBe(policyOf(page(LINKS)));
    expect(html.replace(/<script[^>]*src=[^>]*><\/script>/g, "")).not.toMatch(
      /<script\b|<style\b|\sstyle=|\son[a-z]+=/i,
    );
    for (const tag of html.match(/<nav\b[^>]*>/g) ?? []) expect(tag).toMatch(/aria-label="/);
    for (const tag of html.match(/<section\b[^>]*>/g) ?? []) expect(tag).toMatch(/aria-labelledby="/);
    for (const tag of html.match(/<img\b[^>]*>/g) ?? []) expect(tag).toMatch(/\balt="/);
    expect(html).toMatch(/href="#main"/);
  });

  it("loads nothing from another host and opens outside links safely", () => {
    const markup = html.replace(/<pre[\s\S]*?<\/pre>/g, "");
    const hosts = [...markup.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)].map((m) => new URL(m[1]!).hostname);
    expect(hosts.filter((h) => !["docs.near-intents.org", "github.com", "pnpm.io"].includes(h))).toEqual([]);
    for (const tag of markup.match(/<(?:script|link|img)\b[^>]*>/g) ?? [])
      expect(tag).not.toMatch(/(?:src|href)="https?:/);
    for (const tag of markup.match(/<a\b[^>]*href="https?:[^>]*>/g) ?? []) expect(tag).toMatch(/rel="noopener"/);
  });

  it("draws its buttons from the shared navy set, and gives every code sample a copy button", () => {
    for (const tag of html.match(/<button\b[^>]*>/g) ?? []) {
      expect(tag).toMatch(/\bbtn btn-outline-inverse btn-sm\b/);
      expect(tag).not.toMatch(/bg-(brand|mint|emerald)/);
    }
    const copies = [...html.matchAll(/data-copy="([^"]+)"/g)].map((m) => m[1]!);
    const codes = [...html.matchAll(/<pre\s+id="([^"]+)"/g)].map((m) => m[1]!);
    expect(copies.toSorted()).toEqual(codes.toSorted());
  });

  it("keeps the heading levels in order, so the outline reads correctly", () => {
    const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    for (let i = 1; i < levels.length; i++) expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
  });

  it("has a title and a description of its own", () => {
    expect(html).toMatch(/<title>Tilll · Docs<\/title>/);
    expect(html).toMatch(/<meta\s+name="description"\s+content="[^"]{60,}"/);
  });
});
