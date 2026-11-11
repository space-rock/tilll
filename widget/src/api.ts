import type { PublicAttempt, PublicInvoice } from "./types.js";
import type { TokensPayload } from "./tokens.js";

/** Every way a call to the Tilll server can fail. `code` is the server's error code, or `network` / `bad_response`. */
export class TilllApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TilllApiError";
  }
}

export interface ApiOptions {
  /** The Tilll server, e.g. https://pay.example.com. */
  origin: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

const TIMEOUT_MS = 15_000;

/** The widget's whole view of the server: only the public /pay/* routes, never 1Click. */
export function createApi(options: ApiOptions) {
  const origin = options.origin.replace(/\/+$/, "");
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let status: number;
    let ok: boolean;
    let text: string;
    try {
      const res = await doFetch(`${origin}${path}`, {
        method,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      ({ status, ok } = res);
      text = await res.text();
    } catch {
      throw new TilllApiError(0, "network", "Could not reach the payment server.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TilllApiError(status, "bad_response", "The payment server sent an unexpected answer.");
    }
    if (!ok) {
      const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      throw new TilllApiError(
        status,
        typeof error?.code === "string" ? error.code : "bad_response",
        typeof error?.message === "string" ? error.message : "The payment server reported an error.",
      );
    }
    return parsed as T;
  }

  const id = encodeURIComponent;
  return {
    invoice: (invoiceId: string) => call<PublicInvoice>("GET", `/pay/invoices/${id(invoiceId)}`),
    tokens: () => call<TokensPayload>("GET", "/pay/tokens"),
    createAttempt: (invoiceId: string, body: { originAsset: string; refundTo: string }) =>
      call<PublicAttempt>("POST", `/pay/invoices/${id(invoiceId)}/attempts`, body),
    attempt: (attemptId: string) => call<PublicAttempt>("GET", `/pay/attempts/${id(attemptId)}`),
  };
}

export type Api = ReturnType<typeof createApi>;
