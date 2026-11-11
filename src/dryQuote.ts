import { ConfigError, DEFAULT_MEMO_CHAINS, parseOneClickConfig, type Env } from "./config.js";
import { MoneyError, fromBaseUnits, toBaseUnits } from "./money.js";
import { OneClickError, createOneClickClient, type OneClickClient } from "./oneclick/client.js";
import { paymentQuoteRequest } from "./oneclick/requests.js";
import { SettlementAssetError, createTokenCache, type TokenCache } from "./oneclick/tokens.js";
import type { QuoteRequest, QuoteResponse, Token } from "./oneclick/types.js";

const USAGE = `Usage: pnpm dry-quote --from <chain>:<SYMBOL> --amount <amount> [--refund-to <address>] [--recipient <near-account>]

  --from        what the payer pays with, e.g. base:USDC, sol:SOL, or a full 1Click asset id
  --amount      what the merchant receives, in display units of the settlement asset (e.g. 5 = 5 USDC)
  --refund-to   payer refund address on the origin chain (default: a placeholder EVM address)
  --recipient   settlement NEAR account (default: example.near)

Always a dry run: it asks 1Click for a price and never creates a deposit address.`;

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n\n${USAGE}`);
    this.name = "UsageError";
  }
}

export interface DryQuoteArgs {
  from: string;
  amount: string;
  refundTo?: string;
  recipient?: string;
}

const OPTIONS = {
  "--from": "from",
  "--amount": "amount",
  "--refund-to": "refundTo",
  "--recipient": "recipient",
} as const;

export function parseArgs(argv: string[]): DryQuoteArgs {
  const values: Partial<Record<(typeof OPTIONS)[keyof typeof OPTIONS], string>> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // pnpm forwards the "--" in `pnpm run dry-quote -- --from ...` to the script; it separates runner args, not ours.
    if (arg === "--") continue;
    if (!arg.startsWith("--")) throw new UsageError(`Unexpected argument "${arg}".`);
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const key = (OPTIONS as Record<string, (typeof OPTIONS)[keyof typeof OPTIONS]>)[flag];
    if (!key) throw new UsageError(`Unknown option ${flag}.`);
    let value: string | undefined;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      }
    }
    if (!value) throw new UsageError(`Option ${flag} needs a value.`);
    values[key] = value;
  }
  if (!values.from) throw new UsageError("Missing required option --from.");
  if (!values.amount) throw new UsageError("Missing required option --amount.");
  return {
    from: values.from,
    amount: values.amount,
    ...(values.refundTo ? { refundTo: values.refundTo } : {}),
    ...(values.recipient ? { recipient: values.recipient } : {}),
  };
}

/** A problem the user can fix by changing the command line. Printed without a stack trace. */
export class DryQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DryQuoteError";
  }
}

const PLACEHOLDER_REFUND_TO = "0x0000000000000000000000000000000000000001";
const PLACEHOLDER_RECIPIENT = "example.near";

export interface DryQuoteDeps {
  client: Pick<OneClickClient, "quote">;
  tokens: TokenCache;
  now: Date;
  /** Defaults to the one USDC on NEAR in the token list. */
  settlementAssetId?: string;
  slippageBps?: number;
  deadlineMinutes?: number;
  memoChains?: string[];
}

export interface DryQuoteResult {
  request: QuoteRequest;
  response: QuoteResponse;
  origin: Token;
  settlement: Token;
}

async function resolveOrigin(from: string, tokens: TokenCache): Promise<Token> {
  const exact = await tokens.findAsset(from);
  if (exact) return exact;

  const sep = from.indexOf(":");
  if (sep <= 0 || sep === from.length - 1) {
    throw new DryQuoteError(
      `--from must be <chain>:<SYMBOL> (e.g. base:USDC) or a full 1Click asset id, got "${from}".`,
    );
  }
  const chain = from.slice(0, sep);
  const symbol = from.slice(sep + 1);

  const matches = await tokens.find(chain, symbol);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new DryQuoteError(
      `"${from}" matches more than one token. Pass the full asset id instead:\n` +
        matches.map((t) => `  ${t.assetId}`).join("\n"),
    );
  }

  const grouped = await tokens.byChain();
  const chainKey = Object.keys(grouped).find((k) => k.toLowerCase() === chain.toLowerCase());
  if (!chainKey) {
    throw new DryQuoteError(
      `No tokens on chain "${chain}". Supported chains: ${Object.keys(grouped).toSorted().join(", ")}`,
    );
  }
  const symbols = [...new Set(grouped[chainKey]!.map((t) => t.symbol))].toSorted();
  throw new DryQuoteError(`No token "${symbol}" on chain "${chainKey}". Symbols on ${chainKey}: ${symbols.join(", ")}`);
}

async function resolveSettlement(settlementAssetId: string | undefined, tokens: TokenCache): Promise<Token> {
  if (settlementAssetId) return tokens.resolveSettlementAsset(settlementAssetId);
  const usdc = await tokens.find("near", "USDC");
  if (usdc.length !== 1) {
    throw new DryQuoteError("Could not pick the settlement asset automatically. Set SETTLEMENT_ASSET_ID.");
  }
  return usdc[0]!;
}

/** Ask 1Click what a payment would cost. Hard-wired to dry: true, so it never creates a deposit address. */
export async function runDryQuote(args: DryQuoteArgs, deps: DryQuoteDeps): Promise<DryQuoteResult> {
  const origin = await resolveOrigin(args.from, deps.tokens);
  const settlement = await resolveSettlement(deps.settlementAssetId, deps.tokens);
  const request = paymentQuoteRequest({
    dry: true,
    originAsset: origin,
    invoiceAmount: toBaseUnits(args.amount, settlement.decimals),
    refundTo: args.refundTo ?? PLACEHOLDER_REFUND_TO,
    settlementAssetId: settlement.assetId,
    settlementAccountId: args.recipient ?? PLACEHOLDER_RECIPIENT,
    slippageBps: deps.slippageBps ?? 100,
    deadlineMinutes: deps.deadlineMinutes ?? 30,
    memoChains: deps.memoChains ?? DEFAULT_MEMO_CHAINS,
    now: deps.now,
  });
  const response = await deps.client.quote(request);
  return { request, response, origin, settlement };
}

/** Keep four decimals of a USD string without going through floats. */
const usd = (value: string) => `$${value.replace(/^(\d+\.\d{4}).*$/, "$1")}`;

const row = (label: string, value: string) => `  ${label.padEnd(19)}${value}`;

/** Plain-text report of a dry quote. Shows 1Click's fee fields as returned, without interpreting them. */
export function formatQuote({ request, response, origin, settlement }: DryQuoteResult): string {
  const q = response.quote;
  const lines = [
    "Dry run: priced by 1Click, no deposit address created, nothing sent.",
    "",
    row("Route", `${origin.symbol} on ${origin.blockchain} -> ${settlement.symbol} on ${settlement.blockchain}`),
    row("Settles to", `Intents balance of ${request.recipient}`),
    row(
      "Merchant receives",
      `${fromBaseUnits(q.amountOut, settlement.decimals)} ${settlement.symbol} (${usd(q.amountOutUsd)})`,
    ),
    row("Payer sends", `${fromBaseUnits(q.amountIn, origin.decimals)} ${origin.symbol} (${usd(q.amountInUsd)})`),
    row(
      "Minimum",
      `${fromBaseUnits(q.minAmountIn, origin.decimals)} ${origin.symbol} (below this the deposit is refunded)`,
    ),
    row("Slippage", `${request.slippageTolerance} bps`),
    row("Time estimate", `${q.timeEstimate} s`),
    row("refundFee", `${q.refundFee ?? "-"} (raw, as returned by 1Click)`),
    row("withdrawFee", `${q.withdrawFee ?? "-"} (raw, as returned by 1Click)`),
  ];
  const appFees = response.quoteRequest.appFees ?? [];
  if (appFees.length) {
    lines.push(row("appFees", appFees.map((f) => `${f.fee} bps -> ${f.recipient}`).join("; ") + " (added by 1Click)"));
  }
  lines.push("", row("Correlation id", response.correlationId), row("Signature", response.signature));
  return lines.join("\n");
}

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export interface CliOptions {
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * The whole `pnpm dry-quote` command. Returns the exit code: 0 ok, 1 the request could not be completed,
 * 2 bad usage. Expected failures print one readable message; anything else is a bug and is rethrown with its stack.
 */
export async function runCli(argv: string[], env: Env, io: CliIo, options: CliOptions = {}): Promise<number> {
  let from: string | undefined;
  try {
    const args = parseArgs(argv);
    from = args.from;
    const config = parseOneClickConfig(env);
    const client = createOneClickClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const result = await runDryQuote(args, {
      client,
      tokens: createTokenCache({ client }),
      now: (options.now ?? (() => new Date()))(),
      ...(env.SETTLEMENT_ASSET_ID ? { settlementAssetId: env.SETTLEMENT_ASSET_ID } : {}),
    });
    io.out(formatQuote(result));
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      return 2;
    }
    if (e instanceof OneClickError) {
      const id = e.correlationId ? ` (correlationId ${e.correlationId})` : "";
      // 1Click validates refundTo against the origin chain, and our placeholder is an EVM address.
      const hint =
        e.status === 400 && /refundTo/i.test(e.message)
          ? `\nHint: the default --refund-to is a placeholder EVM address. Pass --refund-to with a valid address on the chain you chose (${from ?? "--from"}).`
          : "";
      io.err(`${e.message}${id}${hint}`);
      return 1;
    }
    if (
      e instanceof ConfigError ||
      e instanceof DryQuoteError ||
      e instanceof SettlementAssetError ||
      e instanceof MoneyError
    ) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }
}
