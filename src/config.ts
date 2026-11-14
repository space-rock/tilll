import { isIP } from "node:net";
import { z } from "zod";

export type Env = Record<string, string | undefined>;

/** Chains that need depositMode MEMO. 1Click's token list has no memo flag, so this is configuration. */
export const DEFAULT_MEMO_CHAINS = ["stellar"];

/** What Fastify takes for `trustProxy`: nothing, everything, a number of proxies, or the addresses of the proxies. */
export type TrustProxy = boolean | number | string[];

const TRUST_KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);
const MAX_PROXY_HOPS = 10;

/** `false`, `true`, a count of proxies (1 to 10), or a comma-separated list of addresses, CIDR ranges and keywords. */
function parseTrustProxy(raw: string): TrustProxy | undefined {
  const value = raw.trim();
  if (value === "false") return false;
  if (value === "true") return true;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return hops >= 1 && hops <= MAX_PROXY_HOPS ? hops : undefined;
  }
  const parts = value.split(",").map((part) => part.trim());
  const valid = parts.every((part) => {
    if (TRUST_KEYWORDS.has(part)) return true;
    const [address = "", prefix, ...rest] = part.split("/");
    const family = isIP(address);
    if (family === 0 || rest.length > 0) return false;
    if (prefix === undefined) return true;
    return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
  });
  return valid ? parts : undefined;
}

export interface OneClickConfig {
  baseUrl: string;
  apiKey: string | undefined;
}

export interface Config {
  port: number;
  publicBaseUrl: string;
  dataDir: string;
  allowedOrigins: string[];
  oneClick: OneClickConfig;
  settlementAccountId: string;
  settlementAssetId: string;
  merchantSecret: string;
  webhookUrl: string;
  webhookSecret: string;
  nearRpcUrl: string;
  attemptDeadlineMinutes: number;
  slippageBps: number;
  memoChains: string[];
  /** Chains the checkout offers beyond those with a strict address check. */
  extraChains: string[];
  /** The NEAR Intents verifier contract. `intents.near` on mainnet; a different account on a testnet. */
  intentsContract: string;
  refundMaxPerTx: string;
  refundMaxPerDay: string;
  /** Whom to believe about where a request came from (`X-Forwarded-For`). Off: nobody, the socket's address is used. */
  trustProxy: TrustProxy;
}

export interface ConfigIssue {
  variable: string;
  message: string;
}

/** Lists every bad variable at once. Messages never include the offending value, so secrets cannot leak into logs. */
export class ConfigError extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i.variable}: ${i.message}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

function parseEnv<T extends z.ZodType>(schema: T, env: Env): z.infer<T> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  throw new ConfigError(
    result.error.issues.map((i) => ({
      variable: String(i.path[0] ?? "(unknown)"),
      message: i.code === "invalid_type" && /undefined/.test(i.message) ? "is required" : i.message,
    })),
  );
}

/** Empty string means "unset" for env vars, so defaults and optionals apply. */
const unsetIfEmpty = (v: unknown) => (v === "" ? undefined : v);
const optionalString = z.preprocess(unsetIfEmpty, z.string().optional());

const list = (raw: string) =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const required = <T extends z.ZodType>(schema: T) => z.preprocess(unsetIfEmpty, schema);
/** What a browser sends as `Origin`: a scheme and host (and port), nothing after. A trailing slash is tolerated and dropped. */
const ORIGIN = /^https?:\/\/[^/\s]+\/*$/i;
export const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const POSITIVE_DECIMAL = /^(?!0+(\.0+)?$)\d+(\.\d+)?$/;
const positiveDecimal = (def: string) =>
  z.preprocess(
    unsetIfEmpty,
    z.string().regex(POSITIVE_DECIMAL, "must be a positive decimal number, e.g. 50").default(def),
  );

/** A URL setting must be http or https: `ftp:` or `file:` would only fail later, quietly, when Tilll tries to use it. */
const httpUrl = () => z.url({ protocol: /^https?$/, error: "must be an http or https URL" });

const oneClickShape = {
  ONECLICK_BASE_URL: z.preprocess(unsetIfEmpty, httpUrl().default("https://1click.chaindefuser.com")),
  ONECLICK_API_KEY: optionalString,
};

const oneClickSchema = z.object(oneClickShape);

const configSchema = z.object({
  ...oneClickShape,
  PORT: z.preprocess(unsetIfEmpty, z.coerce.number().int().min(1).max(65535).default(8080)),
  PUBLIC_BASE_URL: z.preprocess(unsetIfEmpty, httpUrl().optional()),
  DATA_DIR: z.preprocess(unsetIfEmpty, z.string().default("./data")),
  ALLOWED_ORIGINS: z.preprocess(
    unsetIfEmpty,
    z
      .string()
      .default("*")
      .refine(
        (value) => list(value).every((origin) => origin === "*" || ORIGIN.test(origin)),
        "must be * or origins like https://shop.example.com (scheme and host, no path)",
      ),
  ),
  SETTLEMENT_ACCOUNT_ID: required(
    z
      .string()
      .min(2)
      .max(64)
      .regex(NEAR_ACCOUNT, "must be the NEAR account id of a wallet you control, like shop-pay.near"),
  ),
  SETTLEMENT_ASSET_ID: required(
    z.string().regex(/^[a-z0-9_]+:\S+$/, 'must be a 1Click asset id like "nep141:<contract>"'),
  ),
  MERCHANT_SECRET: required(z.string()),
  WEBHOOK_URL: required(httpUrl()),
  WEBHOOK_SECRET: required(z.string()),
  NEAR_RPC_URL: z.preprocess(unsetIfEmpty, httpUrl().default("https://rpc.mainnet.near.org")),
  ATTEMPT_DEADLINE_MINUTES: z.preprocess(unsetIfEmpty, z.coerce.number().int().min(1).max(1440).default(30)),
  SLIPPAGE_BPS: z.preprocess(unsetIfEmpty, z.coerce.number().int().min(0).max(10000).default(100)),
  // Unlike the others, an explicitly empty MEMO_CHAINS means "no memo chains", not "use the default".
  MEMO_CHAINS: z.string().default(DEFAULT_MEMO_CHAINS.join(",")),
  EXTRA_CHAINS: z.preprocess(unsetIfEmpty, z.string().default("")),
  INTENTS_CONTRACT: z.preprocess(
    unsetIfEmpty,
    z
      .string()
      .min(2)
      .max(64)
      .regex(NEAR_ACCOUNT, "must be a NEAR account id like intents.near")
      .default("intents.near"),
  ),
  TRUST_PROXY: z.preprocess(
    unsetIfEmpty,
    z
      .string()
      .default("false")
      .transform((raw, ctx) => {
        const parsed = parseTrustProxy(raw);
        if (parsed === undefined) {
          ctx.addIssue({
            code: "custom",
            message: `must be false, true, a number of proxies (1 to ${MAX_PROXY_HOPS}), or a list of proxy addresses such as 10.0.0.0/8`,
          });
          return z.NEVER;
        }
        return parsed;
      }),
  ),
  REFUND_MAX_PER_TX: positiveDecimal("50"),
  REFUND_MAX_PER_DAY: positiveDecimal("200"),
});

function toOneClick(p: z.infer<typeof oneClickSchema>): OneClickConfig {
  return { baseUrl: p.ONECLICK_BASE_URL.replace(/\/+$/, ""), apiKey: p.ONECLICK_API_KEY };
}

/** The only config `dry-quote` and the 1Click client need. Never requires secrets. */
export function parseOneClickConfig(env: Env): OneClickConfig {
  return toOneClick(parseEnv(oneClickSchema, env));
}

export function parseConfig(env: Env): Config {
  const p = parseEnv(configSchema, env);
  return {
    port: p.PORT,
    // Trailing slashes are dropped: pay links are `${publicBaseUrl}/pay/...` and must not get a double slash.
    publicBaseUrl: (p.PUBLIC_BASE_URL ?? `http://localhost:${p.PORT}`).replace(/\/+$/, ""),
    dataDir: p.DATA_DIR,
    allowedOrigins: list(p.ALLOWED_ORIGINS).map((origin) => origin.replace(/\/+$/, "").toLowerCase()),
    oneClick: toOneClick(p),
    settlementAccountId: p.SETTLEMENT_ACCOUNT_ID,
    settlementAssetId: p.SETTLEMENT_ASSET_ID,
    merchantSecret: p.MERCHANT_SECRET,
    webhookUrl: p.WEBHOOK_URL,
    webhookSecret: p.WEBHOOK_SECRET,
    nearRpcUrl: p.NEAR_RPC_URL,
    attemptDeadlineMinutes: p.ATTEMPT_DEADLINE_MINUTES,
    slippageBps: p.SLIPPAGE_BPS,
    memoChains: list(p.MEMO_CHAINS).map((c) => c.toLowerCase()),
    extraChains: list(p.EXTRA_CHAINS).map((c) => c.toLowerCase()),
    intentsContract: p.INTENTS_CONTRACT,
    refundMaxPerTx: p.REFUND_MAX_PER_TX,
    refundMaxPerDay: p.REFUND_MAX_PER_DAY,
    trustProxy: p.TRUST_PROXY,
  };
}
