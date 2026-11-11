import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".github", "workflows");
const readme = readFileSync(join(root, "README.md"), "utf8");
const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];
const text = (name: string) => readFileSync(join(dir, name), "utf8");

/** Every `uses: owner/repo@ref  # comment` in every workflow. */
const uses = files.flatMap((file) =>
  [...text(file).matchAll(/^\s*-?\s*uses:\s*(\S+)@(\S+)(?:\s+#\s*(.*))?$/gm)].map((m) => ({
    file,
    action: m[1]!,
    ref: m[2]!,
    comment: m[3] ?? "",
  })),
);

describe("the project site's workflow (.github/workflows)", () => {
  it("exists, and publishes the built site", () => {
    expect(files).toContain("pages.yml");
    const workflow = text("pages.yml");
    expect(workflow).toMatch(/^on:\s*\n\s+push:\s*\n\s+branches:\s*\[main\]/m);
    expect(workflow).toMatch(/^\s+workflow_dispatch:/m);
    expect(workflow).toMatch(/pnpm install --frozen-lockfile/);
    expect(workflow).toMatch(/pnpm build:site/);
    expect(workflow).toMatch(/path:\s*site\/dist/);
    expect(workflow).toMatch(/environment:\s*\n\s+name:\s*github-pages/);
  });

  it("pins every action to a full commit, and says which release that is", () => {
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const u of uses) {
      expect([u.action, u.ref]).toEqual([u.action, expect.stringMatching(/^[0-9a-f]{40}$/)]);
      expect([u.action, u.comment]).toEqual([u.action, expect.stringMatching(/^v\d+\.\d+\.\d+$/)]);
    }
  });

  it("is named in the README, action by action, so a reader can see what runs in CI", () => {
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(readme).toContain(u.action);
  });

  it("gives the build job read access only, and the deploy job the Pages permissions alone", () => {
    const workflow = text("pages.yml");
    const top = /^permissions:\s*\n((?:[ \t]+\S.*\n)+)/m.exec(workflow)?.[1] ?? "";
    expect(
      top
        .trim()
        .split("\n")
        .map((l) => l.trim()),
    ).toEqual(["contents: read"]);
    const deploy = workflow.slice(workflow.indexOf("\n  deploy:"));
    expect(deploy).toMatch(/pages:\s*write/);
    expect(deploy).toMatch(/id-token:\s*write/);
    expect(workflow.slice(0, workflow.indexOf("\n  deploy:"))).not.toMatch(/pages:\s*write|id-token:\s*write/);
  });

  it("uses no secret, runs no install script, and does not check the code out in the deploy job", () => {
    const workflow = text("pages.yml");
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).toMatch(/pnpm install --frozen-lockfile --ignore-scripts/);
    expect(workflow.slice(workflow.indexOf("\n  deploy:"))).not.toMatch(/actions\/checkout/);
  });

  it("does not let two deployments run at once", () => {
    expect(text("pages.yml")).toMatch(/concurrency:\s*\n\s+group:\s*pages\s*\n\s+cancel-in-progress:\s*false/);
  });
});
