/** Thin calls to Tidepool's own endpoints (health and faucet). Everything else goes through Tilll's 1Click client. */

export class TidepoolError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "TidepoolError";
  }
}

/** The faucet allows one claim per address per 24 hours and 6 per IP per hour. */
export class FaucetLimitedError extends TidepoolError {
  constructor(readonly retryAfterSeconds: number | undefined) {
    super(
      `Tidepool's faucet is rate limited (one claim per address per 24 hours, 6 per IP per hour)${
        retryAfterSeconds ? `; try again in about ${Math.ceil(retryAfterSeconds / 60)} minutes` : ""
      }.`,
      429,
    );
    this.name = "FaucetLimitedError";
  }
}

async function call(baseUrl: string, path: string, init: RequestInit, doFetch: typeof fetch): Promise<unknown> {
  let response: Response;
  let text: string;
  try {
    response = await doFetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
    text = await response.text();
  } catch (cause) {
    throw new TidepoolError(
      `Tidepool ${path} is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (response.status === 429) {
    const retry = (body as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
    throw new FaucetLimitedError(typeof retry === "number" ? retry : undefined);
  }
  if (!response.ok) {
    const detail = (body as { error?: unknown; message?: unknown } | undefined) ?? {};
    const reason =
      typeof detail.error === "string"
        ? detail.error
        : typeof detail.message === "string"
          ? detail.message
          : text.slice(0, 200);
    throw new TidepoolError(`Tidepool ${path} failed (HTTP ${response.status}): ${reason}`, response.status);
  }
  return body;
}

export const getHealth = (baseUrl: string, doFetch: typeof fetch = fetch) =>
  call(baseUrl, "/v0/health", { method: "GET" }, doFetch);

export type FaucetMode = "intents" | "wallet";

/**
 * Tidepool's faucet. `intents` credits the tokens straight into `accountId`'s balance inside the testnet verifier
 * (no signing, no gas; works for any account id, even one that does not exist). `wallet` puts them on the account
 * itself as ordinary NEP-141 balances, so the account must already exist. Native NEAR is never dripped.
 */
export const faucet = (options: {
  baseUrl: string;
  accountId: string;
  mode: FaucetMode;
  assets?: string[];
  fetch?: typeof fetch;
}) =>
  call(
    options.baseUrl,
    "/v0/faucet",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: options.accountId,
        mode: options.mode,
        ...(options.assets ? { assets: options.assets } : {}),
      }),
    },
    options.fetch ?? fetch,
  );

export const faucetIntents = (options: {
  baseUrl: string;
  accountId: string;
  assets?: string[];
  fetch?: typeof fetch;
}) => faucet({ ...options, mode: "intents" });
