import { exitCode, formatChecks, REGISTER_KEY, runChecks } from "./check.js";
import { NEAR_ACCOUNT, type Env } from "./config.js";
import { InitError, generateKey, initEnv, type RandomBytes } from "./init.js";
import { MAINNET_VERIFIER } from "./near/intents.js";

const USAGE = `Usage: pnpm tilll <command>

  init        Make .env ready to run: copies .env.example if there is no .env, then fills in only what is empty:
              MERCHANT_SECRET, WEBHOOK_SECRET and a settlement key (with the NEAR account that key controls).
              Anything you already set is left alone, and no secret is printed. Safe to run again.
  key [--account <name.near>]
              Make a new settlement key and show how to use it: as the implicit account it controls (nothing to
              register), or for a named account (the one-time registration command, which you run yourself).
  check [--webhook]
              Is this installation ready to take payments? Reads your .env, then looks at 1Click, the
              settlement asset, your API key (with a dry quote), NEAR RPC, the Intents balance, the settlement
              key's registration, and the data directory. Read-only: it never creates a deposit address,
              signs anything, or sends funds, and it never prints a secret.
    --webhook Also send a signed test ping to WEBHOOK_URL (your own server). Off by default.`;

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export interface TilllDeps {
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** The Tilll folder, where `init` finds .env.example. Defaults to the current folder. */
  dir?: string;
  random?: RandomBytes;
}

function runInit(rest: string[], io: CliIo, deps: TilllDeps): number {
  if (rest.length > 0) {
    io.err(`Unknown option ${rest[0]}.\n\n${USAGE}`);
    return 2;
  }
  try {
    const result = initEnv({ dir: deps.dir ?? process.cwd(), ...(deps.random ? { random: deps.random } : {}) });
    const lines: string[] = [];
    if (result.created) lines.push("Created .env from .env.example.");
    for (const name of result.filled) lines.push(`  ${name}: generated`);
    for (const name of result.kept) lines.push(`  ${name}: already set, kept`);
    if (result.filled.length === 0) lines.push("Nothing to fill in: every setting was already set.");
    if (result.settlementAccount) {
      lines.push(
        "",
        `SETTLEMENT_ACCOUNT_ID is ${result.settlementAccount}: a NEAR account controlled by the generated key alone, so it needs no registration.`,
        "To receive money on a named account such as shopname-pay.near instead, set it in .env and register the key: pnpm tilll key --account <your account>.",
      );
    }
    for (const warning of result.warnings) lines.push("", `Warning: ${warning}`);
    lines.push(
      "",
      "No secret was printed. They are in .env, which only you can read and which git ignores. Back it up somewhere safe: the settlement key can spend the settlement balance.",
      "",
      "Next:  docker compose up --build      (or, without Docker: pnpm build && pnpm start:prod)",
      "Then:  open http://localhost:8080/dashboard and log in with MERCHANT_SECRET from .env.",
      "Check: pnpm tilll check",
    );
    io.out(lines.join("\n"));
    return 0;
  } catch (e) {
    if (!(e instanceof InitError)) throw e;
    io.err(e.message);
    return 1;
  }
}

function runKey(rest: string[], env: Env, io: CliIo, deps: TilllDeps): number {
  let account: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--account" && rest[i + 1] !== undefined) {
      account = rest[++i];
    } else {
      io.err(`Unknown option ${rest[i]}.\n\n${USAGE}`);
      return 2;
    }
  }
  if (account !== undefined && !(account.length >= 2 && account.length <= 64 && NEAR_ACCOUNT.test(account))) {
    io.err("--account must be a NEAR account id such as shopname-pay.near.");
    return 2;
  }
  const key = generateKey(deps.random);
  const contract = env.INTENTS_CONTRACT || MAINNET_VERIFIER;
  io.out(
    [
      "A new settlement key. Keep it secret: put it in .env and nowhere else (not in chat, an issue or a screenshot).",
      "",
      `  SETTLEMENT_PRIVATE_KEY=${key.secretKey}`,
      `  Public key:  ${key.publicKey}`,
      "",
      "Option 1, nothing to register: let this key's own NEAR account receive the money.",
      `  SETTLEMENT_ACCOUNT_ID=${key.implicitAccount}`,
      "",
      "Option 2, a named account: set SETTLEMENT_ACCOUNT_ID to it, then register this key once, from that account.",
      "That is a mainnet transaction (1 yoctoNEAR plus gas), so you run it yourself:",
      `  ${REGISTER_KEY(key.publicKey, account ?? "<your-account>", contract)}`,
    ].join("\n"),
  );
  return 0;
}

/** The `tilll` command. Returns the exit code: 0 ok, 1 a check failed, 2 bad usage. */
export async function runTilll(argv: string[], env: Env, io: CliIo, deps: TilllDeps = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return 0;
  }
  if (command === "init") return runInit(rest, io, deps);
  if (command === "key") return runKey(rest, env, io, deps);
  if (command !== "check") {
    io.err(command ? `Unknown command "${command}".\n\n${USAGE}` : USAGE);
    return 2;
  }
  const unknown = rest.find((a) => a !== "--webhook");
  if (unknown) {
    io.err(`Unknown option ${unknown}.\n\n${USAGE}`);
    return 2;
  }
  const results = await runChecks({
    env,
    webhook: rest.includes("--webhook"),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  io.out(formatChecks(results));
  return exitCode(results);
}
