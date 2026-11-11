import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { base58Encode, implicitAccountOf, publicKeyOf } from "./near/keys.js";

export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}

export type RandomBytes = (bytes: number) => Buffer;

export interface NewKey {
  /** `ed25519:<base58>`. Goes in .env as SETTLEMENT_PRIVATE_KEY and nowhere else. */
  secretKey: string;
  publicKey: string;
  /** The NEAR account this key controls on its own: 64 hex characters, no registration needed on the verifier. */
  implicitAccount: string;
}

/** A fresh settlement key. */
export function generateKey(random: RandomBytes = randomBytes): NewKey {
  const secretKey = `ed25519:${base58Encode(random(32))}`;
  return { secretKey, publicKey: publicKeyOf(secretKey), implicitAccount: implicitAccountOf(secretKey) };
}

export interface InitOptions {
  /** The folder holding .env.example (and .env). */
  dir: string;
  /** Injectable for tests. */
  random?: RandomBytes;
}

export interface InitResult {
  /** `.env` did not exist and was made from `.env.example`. */
  created: boolean;
  /** Setting names given a value. Never the values. */
  filled: string[];
  /** Setting names that already had a value of their own and were left alone. */
  kept: string[];
  /** The settlement account init chose, when it did. Not a secret. */
  settlementAccount?: string;
  warnings: string[];
}

const EXAMPLE_ACCOUNT = "shopname-pay.near";
const unset = (value: string, placeholders: string[]) => value === "" || placeholders.includes(value);

/**
 * `tilll init`: make `.env` ready to run. Copies `.env.example` if there is no `.env`, then fills in only the settings
 * that are empty or still the example's placeholder: the merchant secret, the webhook secret, and a settlement key.
 * With a key made here, the settlement account becomes the NEAR implicit account of that key, which needs no
 * registration and which nobody but the holder of the key controls. Anything already set is never touched.
 */
export function initEnv(options: InitOptions): InitResult {
  const random = options.random ?? randomBytes;
  const envPath = join(options.dir, ".env");
  const examplePath = join(options.dir, ".env.example");

  let created = false;
  if (!existsSync(envPath)) {
    if (!existsSync(examplePath)) {
      throw new InitError(`There is no .env and no .env.example in ${options.dir}. Run this from the Tilll folder.`);
    }
    copyFileSync(examplePath, envPath);
    created = true;
  }

  const text = readFileSync(envPath, "utf8");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const assignment = /^([A-Z][A-Z0-9_]*)=(\S*)(.*)$/;

  const current = (name: string) => {
    for (const line of lines) {
      const match = assignment.exec(line);
      if (match?.[1] === name) return match[2]!;
    }
    return undefined;
  };
  const set = (name: string, value: string) => {
    const at = lines.findIndex((line) => assignment.exec(line)?.[1] === name);
    if (at === -1) {
      // A setting that is not in the file at all goes at the end, above a final empty line if there is one.
      const end = lines.at(-1) === "" ? lines.length - 1 : lines.length;
      lines.splice(end, 0, `${name}=${value}`);
      return;
    }
    const match = assignment.exec(lines[at]!)!;
    lines[at] = `${name}=${value}${match[3]}`;
  };

  const filled: string[] = [];
  const kept: string[] = [];
  const warnings: string[] = [];
  const record = (name: string, wasUnset: boolean) => (wasUnset ? filled : kept).push(name);

  const hex = () => random(24).toString("hex");
  const secrets: { name: string; placeholders: string[]; make: () => string }[] = [
    { name: "MERCHANT_SECRET", placeholders: ["sk_live_..."], make: () => `sk_live_${hex()}` },
    { name: "WEBHOOK_SECRET", placeholders: ["whsec_..."], make: () => `whsec_${hex()}` },
  ];
  for (const { name, placeholders, make } of secrets) {
    const wasUnset = unset(current(name) ?? "", placeholders);
    if (wasUnset) set(name, make());
    record(name, wasUnset);
  }

  const keyUnset = unset(current("SETTLEMENT_PRIVATE_KEY") ?? "", ["ed25519:REPLACE_ME", "ed25519:..."]);
  let key: NewKey | undefined;
  if (keyUnset) {
    key = generateKey(random);
    set("SETTLEMENT_PRIVATE_KEY", key.secretKey);
  }
  record("SETTLEMENT_PRIVATE_KEY", keyUnset);

  const account = current("SETTLEMENT_ACCOUNT_ID") ?? "";
  const accountUnset = unset(account, [EXAMPLE_ACCOUNT]);
  let settlementAccount: string | undefined;
  if (accountUnset && key) {
    set("SETTLEMENT_ACCOUNT_ID", key.implicitAccount);
    settlementAccount = key.implicitAccount;
    record("SETTLEMENT_ACCOUNT_ID", true);
  } else {
    record("SETTLEMENT_ACCOUNT_ID", false);
    if (accountUnset) {
      warnings.push(
        `SETTLEMENT_ACCOUNT_ID is still ${account === "" ? "empty" : `the example name ${EXAMPLE_ACCOUNT}`}, but SETTLEMENT_PRIVATE_KEY is yours. Set it to the NEAR account that should receive the money, and register the key for it (pnpm tilll key explains how).`,
      );
    }
  }

  writeFileSync(envPath, lines.join(newline), { mode: 0o600 });
  chmodSync(envPath, 0o600);
  return { created, filled, kept, ...(settlementAccount ? { settlementAccount } : {}), warnings };
}
