import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTilll } from "../src/cli.js";
import { publicKeyOf } from "../src/near/keys.js";
import { fakeFetch } from "./helpers/fakeFetch.js";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

describe("tilll", () => {
  it("prints usage and exits 0 for help, --help or -h", async () => {
    for (const argv of [["help"], ["--help"], ["-h"]]) {
      const { io: streams, out } = io();
      expect(await runTilll(argv, {}, streams)).toBe(0);
      expect(out.join("\n")).toMatch(/Usage: pnpm tilll <command>/);
      for (const command of ["init", "key", "check"]) expect(out.join("\n")).toContain(command);
    }
  });

  it("exits 2 with usage for no command, an unknown command, or an unknown option", async () => {
    for (const argv of [[], ["bogus"], ["check", "--nope"], ["key", "--nope"], ["init", "extra"]]) {
      const { io: streams, err } = io();
      expect(await runTilll(argv, {}, streams)).toBe(2);
      expect(err.join("\n")).toMatch(/Usage:/);
    }
  });

  it("runs the checks, prints the report, and exits 1 when the configuration is invalid", async () => {
    const { io: streams, out, err } = io();
    const { fetch, calls } = fakeFetch(() => ({ body: {} }));

    const code = await runTilll(["check"], {}, streams, { fetch });

    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/✗\s+config/);
    expect(out.join("\n")).toMatch(/MERCHANT_SECRET/);
    expect(err).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("describes check in its usage, including the opt-in webhook ping", async () => {
    const { io: streams, out } = io();
    await runTilll(["help"], {}, streams);
    expect(out.join("\n")).toMatch(/--webhook/);
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const folder = (withExample = true) => {
  const dir = mkdtempSync(join(tmpdir(), "tilll-cli-"));
  dirs.push(dir);
  if (withExample) writeFileSync(join(dir, ".env.example"), readFileSync(new URL("../.env.example", import.meta.url)));
  return dir;
};

describe("tilll init", () => {
  it("makes .env ready, says what it filled and what to do next, and prints no secret", async () => {
    const dir = folder();
    const { io: streams, out } = io();

    expect(await runTilll(["init"], {}, streams, { dir })).toBe(0);

    const text = out.join("\n");
    expect(text).toMatch(/created \.env from \.env\.example/i);
    for (const name of ["MERCHANT_SECRET", "WEBHOOK_SECRET", "SETTLEMENT_PRIVATE_KEY", "SETTLEMENT_ACCOUNT_ID"])
      expect(text).toContain(name);
    expect(text).toMatch(/docker compose up/);
    const env = readFileSync(join(dir, ".env"), "utf8");
    for (const secret of env.match(/(sk_live_|whsec_|ed25519:)[0-9a-zA-Z]+/g) ?? []) expect(text).not.toContain(secret);
  });

  it("says that a second run changed nothing", async () => {
    const dir = folder();
    await runTilll(["init"], {}, io().io, { dir });
    const { io: streams, out } = io();
    expect(await runTilll(["init"], {}, streams, { dir })).toBe(0);
    expect(out.join("\n")).toMatch(/nothing to fill|already set/i);
  });

  it("exits 1 and says where to run it when there is no .env.example", async () => {
    const { io: streams, err } = io();
    expect(await runTilll(["init"], {}, streams, { dir: folder(false) })).toBe(1);
    expect(err.join("\n")).toMatch(/Tilll folder/);
  });

  it("shows a warning the merchant needs to act on", async () => {
    const dir = folder();
    writeFileSync(
      join(dir, ".env"),
      "SETTLEMENT_PRIVATE_KEY=ed25519:7777777777777777777777777777777777777777777\nSETTLEMENT_ACCOUNT_ID=shopname-pay.near\n",
    );
    const { io: streams, out } = io();
    await runTilll(["init"], {}, streams, { dir });
    expect(out.join("\n")).toMatch(/Warning.*SETTLEMENT_ACCOUNT_ID/);
  });
});

async function newKey() {
  const { io: streams, out } = io();
  await runTilll(["key"], {}, streams);
  return /SETTLEMENT_PRIVATE_KEY=(\S+)/.exec(out.join("\n"))![1];
}

describe("tilll key", () => {
  it("makes a settlement key and shows its public key, the account it controls, and how to use a named account instead", async () => {
    const { io: streams, out } = io();
    expect(await runTilll(["key"], {}, streams)).toBe(0);
    const text = out.join("\n");

    const secret = /SETTLEMENT_PRIVATE_KEY=(ed25519:[1-9A-HJ-NP-Za-km-z]+)/.exec(text)![1]!;
    expect(text).toContain(publicKeyOf(secret));
    expect(text).toMatch(/[0-9a-f]{64}/);
    expect(text).toMatch(/add_public_key/);
    expect(text).toContain("<your-account>");
    expect(text).toMatch(/network-config mainnet/);
  });

  it("fills in the account for the registration command, and uses the testnet for a testnet verifier", async () => {
    const { io: streams, out } = io();
    await runTilll(["key", "--account", "shop.testnet"], { INTENTS_CONTRACT: "verifier.example.testnet" }, streams);
    const text = out.join("\n");
    expect(text).toContain("sign-as shop.testnet");
    expect(text).toContain("verifier.example.testnet add_public_key");
    expect(text).toMatch(/network-config testnet/);
  });

  it("refuses an account name that is not a NEAR account id, so nothing odd reaches a shell command", async () => {
    const { io: streams, err } = io();
    expect(await runTilll(["key", "--account", "x; rm -rf /"], {}, streams)).toBe(2);
    expect(err.join("\n")).toMatch(/NEAR account/);
  });

  it("makes a different key every time", async () => {
    expect(await newKey()).not.toBe(await newKey());
  });
});
