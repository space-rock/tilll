import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runTilll } from "../src/cli.js";
import { makeApp } from "./helpers/app.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name: string) => readFileSync(join(root, name), "utf8");
const readme = read("README.md");
const pkg = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

/** The names the "Libraries used" section gives: link texts and `backticked` names, exactly. */
const listedLibraries = () => {
  const section = readme.slice(readme.indexOf("## Libraries used"), readme.indexOf("## Repository layout"));
  const names = new Set<string>();
  for (const m of section.matchAll(/\[([^\]]+)\]\(/g)) names.add(m[1]!);
  for (const m of section.matchAll(/`([^`]+)`/g)) for (const name of m[1]!.split(/,\s*/)) names.add(name);
  return names;
};

const routesIn = (file: string, prefix: string) =>
  [...read(file).matchAll(/app\.(get|post)(?:<[^>]*(?:>[^>]*)*?>)?\(\s*"([^"]+)"/g)].map((m) =>
    `${m[1]!.toUpperCase()} ${prefix}${m[2]}`.replace(/:[a-zA-Z]+/g, ":id"),
  );

/** What the README says is the case, checked against what the repository really holds. */
describe("the README's claims", () => {
  it("lists every library the project depends on, by its exact name", () => {
    const listed = listedLibraries();
    const names = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)];
    expect(names.filter((name) => !listed.has(name))).toEqual([]);
  });

  it("lists no library the project does not depend on (in the library tables)", () => {
    const section = readme.slice(readme.indexOf("## Libraries used"), readme.indexOf("## Repository layout"));
    const linked = [...section.matchAll(/\[([@a-z][\w@/.-]*)\]\(/g)].map((m) => m[1]!);
    const known = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies), "pnpm", "Docker"]);
    const unknown = linked.filter((name) => !known.has(name) && !/^(pnpm|Docker)$/i.test(name));
    expect(unknown).toEqual([]);
  });

  it("only tells the reader to run pnpm scripts that exist", () => {
    const builtins = new Set(["install", "exec", "add", "run"]);
    const used = new Set<string>();
    for (const match of readme.matchAll(/pnpm (?:run )?([a-z][a-z:-]*)/g)) used.add(match[1]!);
    const missing = [...used].filter((name) => !(name in pkg.scripts) && !builtins.has(name));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(5);
  });

  it("only names `tilll` subcommands that the CLI has", async () => {
    const out: string[] = [];
    await runTilll(["help"], {}, { out: (s) => out.push(s), err: () => undefined });
    const usage = out.join("\n");
    const named = new Set([...readme.matchAll(/pnpm tilll ([a-z]+)/g)].map((m) => m[1]!));
    for (const command of named) expect(usage).toContain(command);
    expect(named).toEqual(new Set(["init", "key", "check"]));
  });

  it("documents every setting in .env.example", () => {
    const names = [...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
    const missing = names.filter((name) => !readme.includes(`\`${name}\``));
    expect(missing).toEqual([]);
    expect(names.length).toBeGreaterThan(15);
  });

  it("documents every route it lists, and each one exists", async () => {
    const rows = [...readme.matchAll(/^\| (GET|POST) \| `([^`]+)` \|/gm)].map((m) => ({
      method: m[1] as "GET" | "POST",
      path: m[2]!,
    }));
    expect(rows.length).toBeGreaterThanOrEqual(19);
    const { app } = await makeApp();
    const ULID = "01M6XB4JSTR4YT9EJEZWP0QHMQ";
    const missing: string[] = [];
    for (const { method, path } of rows) {
      const url = path.replace("/pay/:invoiceId", `/pay/inv_${ULID}`).replace(/:id/g, `inv_${ULID}`);
      const response = await app.inject({ method, url, payload: method === "POST" ? {} : undefined });
      const body = response.body.startsWith("{") ? (JSON.parse(response.body) as { error?: { message?: string } }) : {};
      // A 404 from a missing record is fine; "No such route." means nothing handles this URL.
      if (response.statusCode === 404 && body.error?.message === "No such route.") missing.push(`${method} ${path}`);
    }
    expect(missing).toEqual([]);
  });

  it("mentions every merchant and public route the server really has", () => {
    const real = [
      ...routesIn("src/routes/merchant.ts", "/v1"),
      ...routesIn("src/routes/pay.ts", "/pay"),
      ...routesIn("src/routes/pages.ts", "/pay").filter((r) => r.includes(":id")),
    ];
    const documented = new Set(
      [...readme.matchAll(/^\| (GET|POST) \| `([^`]+)` \|/gm)].map((m) =>
        `${m[1]} ${m[2]}`.replace(/:[a-zA-Z]+/g, ":id"),
      ),
    );
    expect(real.length).toBeGreaterThanOrEqual(19);
    expect(real.filter((route) => !documented.has(route))).toEqual([]);
  });

  it("links only to files and folders that exist", () => {
    const links = [...readme.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)]
      .map((m) => m[1]!)
      .filter((href) => !/^https?:/.test(href));
    expect(links.length).toBeGreaterThan(3);
    const missing = links.filter((href) => !existsSync(join(root, href)));
    expect(missing).toEqual([]);
  });

  it("states no fee figure that was not measured (the unauthenticated fee differs by route; dry-quote shows it)", () => {
    expect(readme).not.toMatch(/0\.25\s?%/);
    expect(read(".env.example")).not.toMatch(/0\.25\s?%/);
    expect(readme).toMatch(/appFees/);
  });

  it("documents the proofVerified field and says what it does and does not cover", () => {
    expect(readme).toMatch(/proofVerified/);
    expect(readme).toMatch(/does not cover a status value/);
    expect(readme).toContain("reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc");
  });

  it("claims no code from before the hackathon window, and the history agrees", () => {
    expect(readme).toMatch(/no code from before the window/);
    if (!existsSync(join(root, ".git"))) return;
    const first = execFileSync("git", ["log", "--reverse", "--format=%cI"], { cwd: root, encoding: "utf8" }).split(
      "\n",
    )[0]!;
    expect(Date.parse(first)).toBeGreaterThanOrEqual(Date.parse("2026-11-01T00:00:00Z"));
    expect(readme).toContain(`from ${first.slice(0, 10)}`);
  });

  it("tells a merchant whose page sets a Content-Security-Policy what to allow for the checkout, images included", () => {
    const embed = readme.slice(readme.indexOf("## Embed"), readme.indexOf("## Configuration"));
    expect(embed).toMatch(/Content-Security-Policy/);
    for (const directive of ["script-src", "connect-src", "img-src"]) expect(embed).toContain(directive);
  });

  it("does not mention the private development harness", () => {
    expect(readme).not.toMatch(/tidepool|testnet:/i);
  });

  it("makes no claim of a mainnet run that has not happened", () => {
    expect(readme).toMatch(/Not yet run by the author/);
    expect(readme).not.toMatch(/tested on mainnet|verified on mainnet/i);
  });
});

/** The lowest Node version an `engines.node` range allows, as [major, minor]: the lowest bound over its `||` alternatives. */
function lowestNode(range: string): [number, number] {
  const lows = range.split("||").map((alt) => {
    const m = /(\d+)(?:\.(\d+))?/.exec(alt.trim().replace(/^[\^>=~\s]+/, ""));
    return [Number(m?.[1] ?? 0), Number(m?.[2] ?? 0)] as [number, number];
  });
  return lows.toSorted((a, b) => a[0] - b[0] || a[1] - b[1])[0]!;
}

describe("the Node version the README asks for", () => {
  const engines = (JSON.parse(read("package.json")) as { engines: { node: string } }).engines.node;
  const needed = (() => {
    const names = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)];
    let max: [number, number] = [0, 0];
    for (const name of names) {
      const file = join(root, "node_modules", name, "package.json");
      if (!existsSync(file)) continue;
      const range = (JSON.parse(readFileSync(file, "utf8")) as { engines?: { node?: string } }).engines?.node;
      if (!range) continue;
      const low = lowestNode(range);
      if (low[0] > max[0] || (low[0] === max[0] && low[1] > max[1])) max = low;
    }
    return max;
  })();

  it("is not older than what the installed dependencies need (a Node that cannot run the tests or the server)", () => {
    const [major, minor] = lowestNode(engines);
    expect([major, minor].join(".")).not.toBe("0.0");
    expect(major * 1000 + minor).toBeGreaterThanOrEqual(needed[0] * 1000 + needed[1]);
  });

  it("is the same in package.json, the README and both runbooks", () => {
    const [major, minor] = lowestNode(engines);
    const stated = `Node ${major}.${minor}`;
    for (const text of [readme, read("scripts/mainnet-smoke.md")]) {
      expect(text).toContain(`${stated} or newer`);
      expect(text).not.toMatch(/Node 20\.12/);
    }
  });
});

describe("packaging", () => {
  const dockerfile = read("Dockerfile");
  const compose = read("docker-compose.yml");
  const ignore = read(".dockerignore").split("\n");

  it("keeps secrets out of the image and out of the compose file", () => {
    expect(ignore).toEqual(expect.arrayContaining([".env", "data", ".git", "node_modules"]));
    expect(dockerfile).not.toMatch(/COPY[^\n]*\.env\b(?!\.example)/);
    for (const text of [dockerfile, compose])
      expect(text).not.toMatch(/sk_live_|whsec_[0-9a-f]|ed25519:[1-9A-HJ-NP-Za-km-z]{20,}/);
  });

  it("runs as an unprivileged user, with a health check, and keeps its data on a volume", () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/^HEALTHCHECK /m);
    expect(compose).toMatch(/tilll-data:\/app\/data/);
    expect(compose).toMatch(/env_file:\s*\.env/);
  });

  it("publishes the port to this machine only, not to the network", () => {
    expect(compose).toMatch(/"127\.0\.0\.1:\$\{PORT:-8080\}:8080"/);
  });

  it("builds the same way the README says to build without Docker", () => {
    expect(dockerfile).toMatch(/pnpm build/);
    expect(pkg.scripts.build).toMatch(/build:server/);
    expect(pkg.scripts["start:prod"]).toBe("node dist/main.js");
    expect(dockerfile).toMatch(/CMD \["node", "dist\/main\.js"\]/);
  });

  it("uses the pnpm the project pins", () => {
    const pinned = /"packageManager": "pnpm@([\d.]+)"/.exec(read("package.json"))![1];
    expect(dockerfile).toContain(`pnpm@${pinned}`);
  });
});

describe("secrets and git", () => {
  it("ships .env.example with no secret in it", () => {
    const text = read(".env.example");
    expect(text).toMatch(/^MERCHANT_SECRET=\s/m);
    expect(text).toMatch(/^WEBHOOK_SECRET=\s/m);
    expect(text).not.toMatch(/sk_live_[0-9a-f]|whsec_[0-9a-f]/);
    expect(text).toMatch(/SETTLEMENT_PRIVATE_KEY=ed25519:REPLACE_ME/);
  });

  it("ignores .env and data/ in git", () => {
    const rules = read(".gitignore").split("\n");
    expect(rules).toContain(".env");
    expect(rules).toContain("data/");
    expect(rules).toContain("!.env.example");
  });

  it("tracks no .env file and nothing under data/", () => {
    if (!existsSync(join(root, ".git"))) return;
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
    expect(tracked.filter((f) => /^\.env($|\.(?!example$))/.test(f) || f.startsWith("data/"))).toEqual([]);
  });
});
