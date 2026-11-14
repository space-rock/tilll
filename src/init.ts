import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}

export type RandomBytes = (bytes: number) => Buffer;

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
  warnings: string[];
}

const EXAMPLE_ACCOUNT = "shopname-pay.near";
const unset = (value: string, placeholders: string[]) => value === "" || placeholders.includes(value);

/**
 * `tilll init`: make `.env` ready to run. Copies `.env.example` if there is no `.env`, then fills in only the settings
 * that are empty or still the example's placeholder: the merchant secret and the webhook secret. It makes no key: refunds
 * are approved with a wallet in the dashboard. The settlement account is the merchant's own, so it is never invented;
 * init only says so when it is missing. Anything already set is never touched.
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

  const account = current("SETTLEMENT_ACCOUNT_ID") ?? "";
  const accountUnset = unset(account, [EXAMPLE_ACCOUNT]);
  record("SETTLEMENT_ACCOUNT_ID", false);
  if (accountUnset) {
    warnings.push(
      `SETTLEMENT_ACCOUNT_ID is still ${account === "" ? "empty" : `the example name ${EXAMPLE_ACCOUNT}`}. Set it to the NEAR account that should receive the money: the account of the wallet you will connect in the dashboard to approve refunds. Tilll will not start without it.`,
    );
  }

  writeFileSync(envPath, lines.join(newline), { mode: 0o600 });
  chmodSync(envPath, 0o600);
  return { created, filled, kept, warnings };
}
