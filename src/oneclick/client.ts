import type {
  DepositSubmitRequest,
  GenerateIntentRequest,
  GenerateIntentResponse,
  QuoteRequest,
  QuoteResponse,
  StatusQuery,
  StatusResponse,
  SubmitIntentRequest,
  SubmitIntentResponse,
  Token,
} from "./types.js";

export interface OneClickClientOptions {
  baseUrl: string;
  /** Partner JWT. Sent as X-API-Key; omitted entirely when unset. */
  apiKey?: string | undefined;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
}

/**
 * The single error type for every 1Click failure. `status` is the HTTP status, or 0 when no response
 * arrived (network error, timeout). Carries only response data, never request headers, so the API key
 * cannot leak through it.
 */
export class OneClickError extends Error {
  readonly status: number;
  readonly correlationId: string | undefined;
  readonly body: unknown;

  constructor(
    status: number,
    message: string,
    details: { correlationId?: string; body?: unknown; cause?: unknown } = {},
  ) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "OneClickError";
    this.status = status;
    this.correlationId = details.correlationId;
    this.body = details.body;
  }
}

const describeCause = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createOneClickClient(options: OneClickClientOptions) {
  const doFetch = options.fetch ?? fetch;

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown, abort?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.apiKey) headers["X-API-Key"] = options.apiKey;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const label = `1Click ${method} ${path.split("?")[0]}`;

    let status: number;
    let ok: boolean;
    let text: string;
    try {
      const res = await doFetch(`${options.baseUrl}${path}`, {
        method,
        headers,
        signal: abort
          ? AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 30_000), abort])
          : AbortSignal.timeout(options.timeoutMs ?? 30_000),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      status = res.status;
      ok = res.ok;
      text = await res.text();
    } catch (cause) {
      throw new OneClickError(0, `${label} failed: ${describeCause(cause)}`, { cause });
    }

    let parsed: unknown;
    let isJson = true;
    try {
      parsed = JSON.parse(text);
    } catch {
      isJson = false;
    }

    if (!ok) {
      const record = isJson && parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
      const detail = typeof record?.message === "string" ? record.message : text.slice(0, 200);
      const correlationId = typeof record?.correlationId === "string" ? record.correlationId : undefined;
      throw new OneClickError(status, `${label} failed (${status}): ${detail}`, {
        ...(correlationId ? { correlationId } : {}),
        body: isJson ? parsed : text,
      });
    }
    if (!isJson) {
      throw new OneClickError(status, `${label} returned a body that is not valid JSON: ${text.slice(0, 200)}`, {
        body: text,
      });
    }
    return parsed as T;
  }

  return {
    tokens: () => request<Token[]>("GET", "/v0/tokens"),
    quote: (req: QuoteRequest) => request<QuoteResponse>("POST", "/v0/quote", req),
    /** `signal` lets the caller abandon the request, for a clean shutdown. */
    status: (query: StatusQuery, call: { signal?: AbortSignal } = {}) => {
      const params = new URLSearchParams({ depositAddress: query.depositAddress });
      if (query.depositMemo) params.set("depositMemo", query.depositMemo);
      return request<StatusResponse>("GET", `/v0/status?${params}`, undefined, call.signal);
    },
    depositSubmit: (req: DepositSubmitRequest) => request<StatusResponse>("POST", "/v0/deposit/submit", req),
    generateIntent: (req: GenerateIntentRequest) => request<GenerateIntentResponse>("POST", "/v0/generate-intent", req),
    submitIntent: (req: SubmitIntentRequest) => request<SubmitIntentResponse>("POST", "/v0/submit-intent", req),
  };
}

export type OneClickClient = ReturnType<typeof createOneClickClient>;
