import { exitCode, formatChecks, runChecks } from "./check.js";
import type { Env } from "./config.js";
import { InitError, initEnv, type RandomBytes } from "./init.js";

const USAGE = `Usage: pnpm tilll <command>

  init        Make .env ready to run: copies .env.example if there is no .env, then fills in only what is empty:
              MERCHANT_SECRET and WEBHOOK_SECRET. Anything you already set is left alone, and no secret is
              printed. Safe to run again. You still set SETTLEMENT_ACCOUNT_ID yourself: the NEAR account of the
              wallet that will approve refunds.
  check [--webhook]
              Is this installation ready to take payments? Reads your .env, then looks at 1Click, the
              settlement asset, your API key (with a dry quote), NEAR RPC, the Intents balance and the data
              directory. Read-only: it never creates a deposit address,
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
    for (const warning of result.warnings) lines.push("", `Warning: ${warning}`);
    lines.push(
      "",
      "No secret was printed. They are in .env, which only you can read and which git ignores. Tilll holds no key that can spend your money: refunds are approved with your wallet in the dashboard.",
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

/** The `tilll` command. Returns the exit code: 0 ok, 1 a check failed, 2 bad usage. */
export async function runTilll(argv: string[], env: Env, io: CliIo, deps: TilllDeps = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return 0;
  }
  if (command === "init") return runInit(rest, io, deps);
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
