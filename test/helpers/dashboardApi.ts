import { vi } from "vitest";

export interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

type Reply = { status?: number; body?: unknown };
type Handler = Reply | ((call: Call) => Reply | Promise<Reply>);

/**
 * Stands in for the Tilll server in dashboard tests. `routes` maps "METHOD /path" (without a query string) to a reply or a
 * function making one. Every request is recorded; one nobody planned for fails the test loudly.
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const table = new Map(Object.entries(routes));
  const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const call: Call = {
      method,
      path: url.pathname + url.search,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
    };
    calls.push(call);
    const handler = table.get(`${method} ${url.pathname}`);
    if (!handler) {
      return new Response(
        JSON.stringify({ error: { code: "not_found", message: `Unplanned ${method} ${url.pathname}` } }),
        { status: 404 },
      );
    }
    const reply = typeof handler === "function" ? await handler(call) : handler;
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    /** Replace or add a route while a test runs. */
    set: (route: string, handler: Handler) => void table.set(route, handler),
    to: (method: string, path: string) => calls.filter((c) => c.method === method && c.path.split("?")[0] === path),
  };
}

export const invoice = (over: Record<string, unknown> = {}) => ({
  id: "inv_01M6XB4JSTR4YT9EJEZWP0QHMQ",
  status: "paid",
  amount: "12.5",
  amountBase: "12500000",
  refundedAmount: "0",
  refundedAmountBase: "0",
  asset: { id: "nep141:usdc", symbol: "USDC", decimals: 6 },
  description: "Sample invoice",
  metadata: null,
  paidAttemptId: "att_1",
  expiresAt: "2026-11-08T19:54:00.000Z",
  createdAt: "2026-11-08T15:54:00.000Z",
  updatedAt: "2026-11-08T15:55:00.000Z",
  ...over,
});

export const attempt = (over: Record<string, unknown> = {}) => ({
  id: "att_1",
  invoiceId: "inv_01M6XB4JSTR4YT9EJEZWP0QHMQ",
  status: "paid",
  origin: { assetId: "nep141:base-usdc", chain: "base", symbol: "USDC", decimals: 6 },
  refundTo: "0x1111111111111111111111111111111111111111",
  depositAddress: "0xDEPOSIT0000000000000000000000000000001",
  depositMemo: null,
  amountIn: "12.62875",
  oneclickStatus: "SUCCESS",
  depositTxHash: "0xtx1",
  txLinks: [{ hash: "0xtx1", explorerUrl: "https://basescan.org/tx/0xtx1" }],
  deadline: "2026-11-08T16:24:00.000Z",
  createdAt: "2026-11-08T15:54:30.000Z",
  updatedAt: "2026-11-08T15:55:00.000Z",
  raw: { quote: { quote: {} }, status: null, quoteVerified: true },
  ...over,
});

export const refund = (over: Record<string, unknown> = {}) => ({
  id: "ref_1",
  invoiceId: "inv_01M6XB4JSTR4YT9EJEZWP0QHMQ",
  attemptId: "att_1",
  amount: "5",
  amountBase: "5000000",
  reason: "merchant_request",
  status: "submitted",
  idempotencyKey: "k",
  intentHash: "hash",
  error: null,
  tries: 0,
  nextTryAt: null,
  txLinks: [],
  createdAt: "2026-11-08T16:00:00.000Z",
  updatedAt: "2026-11-08T16:00:00.000Z",
  ...over,
});

export const preview = (over: Record<string, unknown> = {}) => ({
  invoiceId: "inv_01M6XB4JSTR4YT9EJEZWP0QHMQ",
  amount: "12.5",
  amountBase: "12500000",
  destination: {
    assetId: "nep141:base-usdc",
    chain: "base",
    symbol: "USDC",
    decimals: 6,
    address: "0x1111111111111111111111111111111111111111",
  },
  estimate: {
    amountOut: "12490000",
    amountOutFormatted: "12.49",
    amountOutUsd: "12.49",
    withdrawFee: "0.01",
    timeEstimate: 35,
  },
  note: "Refunds return the value at today's price, so the customer may receive a different amount than they paid.",
  ...over,
});
