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
