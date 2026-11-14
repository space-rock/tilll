/** A NEAR RPC call that failed, or answered something unusable. */
export class NearRpcError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NearRpcError";
  }
}

export interface ViewCall {
  rpcUrl: string;
  contractId: string;
  method: string;
  args: Record<string, unknown>;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * A read-only contract view call over JSON-RPC (`query` / `call_function`). Moves no funds and signs nothing.
 * Returns the contract's JSON result.
 */
export async function callView(call: ViewCall): Promise<unknown> {
  const doFetch = call.fetch ?? fetch;
  const label = `${call.contractId}.${call.method}`;

  let text: string;
  let status: number;
  try {
    const response = await doFetch(call.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(call.timeoutMs ?? 15_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "tilll",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: call.contractId,
          method_name: call.method,
          args_base64: Buffer.from(JSON.stringify(call.args)).toString("base64"),
        },
      }),
    });
    status = response.status;
    text = await response.text();
  } catch (cause) {
    throw new NearRpcError(`NEAR RPC ${label} failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }

  if (status < 200 || status > 299) throw new NearRpcError(`NEAR RPC ${label} failed (HTTP ${status}).`);
  let body: { result?: { result?: number[]; error?: string }; error?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    throw new NearRpcError(`NEAR RPC ${label} returned something that is not JSON.`);
  }
  if (body.error) throw new NearRpcError(`NEAR RPC ${label} failed: ${JSON.stringify(body.error).slice(0, 300)}`);
  if (body.result?.error)
    throw new NearRpcError(`NEAR contract call ${label} failed: ${String(body.result.error).slice(0, 300)}`);
  if (!Array.isArray(body.result?.result)) throw new NearRpcError(`NEAR RPC ${label} returned no result.`);
  try {
    return JSON.parse(Buffer.from(body.result.result).toString("utf8"));
  } catch {
    throw new NearRpcError(`NEAR RPC ${label} returned a result that is not JSON.`);
  }
}

const isMissingKey = (name: string | undefined) => name === "UNKNOWN_ACCESS_KEY" || name === "UNKNOWN_ACCOUNT";

/** What an account's key may do: everything, only call certain contracts, or the account has no such key. */
export type AccessKeyKind = "full" | "function_call" | "none";

/**
 * Whether `publicKey` is an access key of `accountId`, and of which kind (`query` / `view_access_key`). Reads only.
 * A key that does not exist is an answer ("none"), not an error.
 */
export async function viewAccessKey(options: {
  rpcUrl: string;
  accountId: string;
  publicKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<AccessKeyKind> {
  const doFetch = options.fetch ?? fetch;
  let status: number;
  let text: string;
  try {
    const response = await doFetch(options.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "tilll",
        method: "query",
        params: {
          request_type: "view_access_key",
          finality: "final",
          account_id: options.accountId,
          public_key: options.publicKey,
        },
      }),
    });
    status = response.status;
    text = await response.text();
  } catch (cause) {
    throw new NearRpcError(
      `NEAR RPC view_access_key failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
      },
    );
  }
  if (status < 200 || status > 299) throw new NearRpcError(`NEAR RPC view_access_key failed (HTTP ${status}).`);
  let body: { result?: { permission?: unknown; error?: string }; error?: { cause?: { name?: string } } };
  try {
    body = JSON.parse(text);
  } catch {
    throw new NearRpcError("NEAR RPC view_access_key returned something that is not JSON.");
  }
  if (body.error) {
    if (isMissingKey(body.error.cause?.name)) return "none";
    throw new NearRpcError(`NEAR RPC view_access_key failed: ${JSON.stringify(body.error).slice(0, 300)}`);
  }
  // Older nodes answer a missing key as a result with an error string.
  if (typeof body.result?.error === "string") {
    if (/does not exist/i.test(body.result.error)) return "none";
    throw new NearRpcError(`NEAR RPC view_access_key failed: ${body.result.error.slice(0, 300)}`);
  }
  const permission = body.result?.permission;
  if (permission === "FullAccess") return "full";
  if (typeof permission === "object" && permission !== null && "FunctionCall" in permission) return "function_call";
  throw new NearRpcError("NEAR RPC view_access_key returned no permission.");
}
