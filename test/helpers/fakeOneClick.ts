import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { verifyNep413 } from "../../src/near/nep413.js";
import type {
  QuoteRequest,
  QuoteResponse,
  SignedNep413Intent,
  StatusResponse,
  SwapDetails,
  SwapStatus,
} from "../../src/oneclick/types.js";
import quoteFixture from "../fixtures/quote-dry-exact-output.json" with { type: "json" };
import tokensFixture from "../fixtures/tokens.json" with { type: "json" };

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, any> | undefined;
}

const REQUIRED_QUOTE_FIELDS = [
  "dry",
  "swapType",
  "slippageTolerance",
  "originAsset",
  "depositType",
  "destinationAsset",
  "amount",
  "refundTo",
  "refundType",
  "recipient",
  "recipientType",
  "deadline",
] as const;

/** Address formats the real 1Click enforced when probed live (a wrong-chain or garbage refundTo is a 400). */
const ADDRESS: Record<string, RegExp> = {
  base: /^0x[0-9a-fA-F]{40}$/,
  eth: /^0x[0-9a-fA-F]{40}$/,
  arb: /^0x[0-9a-fA-F]{40}$/,
  sol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  stellar: /^G[A-Z2-7]{55}$/,
};

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const txLink = (address: string): SwapDetails => ({
  originChainTxHashes: [
    { hash: `0xtx${address.slice(-4)}`, explorerUrl: `https://fake.explorer/tx/${address.slice(-4)}` },
  ],
  destinationChainTxHashes: [
    { hash: `0xout${address.slice(-4)}`, explorerUrl: `https://fake.explorer/tx/out${address.slice(-4)}` },
  ],
});

/**
 * A stand-in for https://1click.chaindefuser.com that speaks real HTTP, so the genuine client and `fetch` are
 * exercised. Behaviour mirrors what was observed live: quotes return 201, `refundTo` is format-checked per chain,
 * `depositMode` is checked per chain, and a quote with a memo needs `depositMemo` on /v0/status.
 */
export async function startFakeOneClick(
  options: {
    memoChains?: string[];
    autoPay?: { stepMs: number };
    /** The clock refund intents get their deadline from. Defaults to the real one. */
    now?: () => Date;
    /** The verifier contract refund intents are addressed to. */
    verifier?: string;
  } = {},
) {
  const now = options.now ?? (() => new Date());
  const verifier = options.verifier ?? "intents.near";
  const memoChains = new Set(options.memoChains ?? ["stellar"]);
  const tokens = tokensFixture as { assetId: string; blockchain: string }[];
  const requests: FakeRequest[] = [];
  const quotes = new Map<string, QuoteResponse>();
  const statuses = new Map<string, { status: SwapStatus; swapDetails: SwapDetails }>();
  const failures: { path: string; status: number; body: unknown }[] = [];
  let quoteCount = 0;
  /** Intents handed out by generate-intent, by nonce, and the signed ones submit-intent accepted. */
  const issued = new Map<string, { message: string; depositAddress: string; used: boolean }>();
  const submitted: SignedNep413Intent[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  let pendingAutoPay = 0;

  const statusResponse = (address: string): StatusResponse => {
    const current = statuses.get(address)!;
    return {
      correlationId: `fake-status-${address}`,
      quoteResponse: quotes.get(address)!,
      status: current.status,
      updatedAt: new Date().toISOString(),
      swapDetails: current.swapDetails,
    };
  };

  function handleQuote(req: FakeRequest, res: ServerResponse) {
    const body = (req.body ?? {}) as Partial<QuoteRequest>;
    for (const field of REQUIRED_QUOTE_FIELDS) {
      if (body[field] === undefined) return json(res, 400, { message: `${field} should not be empty` });
    }
    const origin = tokens.find((t) => t.assetId === body.originAsset);
    if (!origin) return json(res, 400, { message: "originAsset is not supported" });
    const format = ADDRESS[origin.blockchain];
    if (format && !format.test(body.refundTo!)) return json(res, 400, { message: "refundTo is not valid" });
    const wantsMemo = memoChains.has(origin.blockchain);
    if (body.depositMode !== undefined && (body.depositMode === "MEMO") !== wantsMemo) {
      return json(res, 400, { message: `Incorrect depositMode for originAsset from ${origin.blockchain} chain` });
    }

    const n = ++quoteCount;
    const base = quoteFixture as unknown as QuoteResponse;
    const amount = BigInt(body.amount!);
    const response: QuoteResponse = {
      ...base,
      correlationId: `fake-corr-${n}`,
      signature: `ed25519:FAKESIG${n}`,
      timestamp: new Date().toISOString(),
      quoteRequest: { ...base.quoteRequest, ...(body as QuoteRequest) },
      quote: {
        ...base.quote,
        amountOut: body.amount!,
        // Shown to people in the demo: 6 decimals like USDC, the asset every amount in the demo is in.
        amountOutFormatted: (Number(body.amount) / 1_000_000).toString(),
        minAmountOut: body.amount!,
        amountIn: ((amount * 10103n) / 10000n).toString(),
        minAmountIn: ((amount * 10002n) / 10000n).toString(),
        ...(body.dry
          ? {}
          : {
              depositAddress: `0xFAKE${String(n).padStart(36, "0")}`,
              // Observed live: 3 days after the requested deadline (when the address goes inactive).
              deadline: new Date(Date.parse(body.deadline!) + 3 * 24 * 60 * 60_000).toISOString(),
              timeWhenInactive: new Date(Date.parse(body.deadline!) + 3 * 24 * 60 * 60_000).toISOString(),
              ...(wantsMemo ? { depositMemo: "12345" } : {}),
            }),
      },
    };
    if (!body.dry) {
      const address = response.quote.depositAddress!;
      quotes.set(address, response);
      statuses.set(address, { status: "PENDING_DEPOSIT", swapDetails: {} });
      // A mock payer for demos: the deposit shows up, is processed, and succeeds, one step apart.
      if (options.autoPay) {
        const { stepMs } = options.autoPay;
        (["KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"] as const).forEach((next, i) => {
          pendingAutoPay++;
          const timer = setTimeout(
            () => {
              pendingAutoPay--;
              fake.setStatus(address, next, txLink(address));
            },
            (i + 1) * stepMs,
          );
          timer.unref();
          timers.push(timer);
        });
      }
    }
    return json(res, 201, response);
  }

  function handleStatus(req: FakeRequest, res: ServerResponse) {
    const address = req.query.get("depositAddress") ?? "";
    const known = quotes.get(address);
    if (!known) return json(res, 404, { message: "Deposit address not found" });
    if (known.quote.depositMemo && req.query.get("depositMemo") !== known.quote.depositMemo) {
      return json(res, 400, { message: "depositMemo is required for this deposit address" });
    }
    return json(res, 200, statusResponse(address));
  }

  function handleDepositSubmit(req: FakeRequest, res: ServerResponse) {
    const address = String(req.body?.depositAddress ?? "");
    if (!quotes.has(address)) return json(res, 404, { message: "Deposit address not found" });
    statuses.set(address, {
      status: "KNOWN_DEPOSIT_TX",
      swapDetails: {
        originChainTxHashes: [
          { hash: String(req.body?.txHash), explorerUrl: `https://fake.explorer/tx/${req.body?.txHash}` },
        ],
      },
    });
    return json(res, 200, statusResponse(address));
  }

  /** What the real one does for a refund (an INTENTS deposit): an intent that pays the quote's deposit address. */
  function handleGenerateIntent(req: FakeRequest, res: ServerResponse) {
    const { type, standard, signerId, depositAddress } = (req.body ?? {}) as Record<string, string>;
    if (type !== "swap_transfer" || standard !== "nep413") {
      return json(res, 400, { message: "type must be swap_transfer and standard nep413" });
    }
    if (!signerId) return json(res, 400, { message: "signerId should not be empty" });
    const quote = quotes.get(depositAddress ?? "");
    if (!quote) return json(res, 404, { message: "Deposit address not found" });
    if (quote.quoteRequest.depositType !== "INTENTS") {
      return json(res, 400, { message: "generate-intent needs a quote with depositType INTENTS" });
    }
    const nonce = randomBytes(32).toString("base64");
    const message = JSON.stringify({
      signer_id: signerId,
      deadline: new Date(now().getTime() + 15 * 60_000).toISOString(),
      intents: [
        {
          intent: "transfer",
          receiver_id: depositAddress,
          tokens: { [quote.quoteRequest.originAsset]: quote.quoteRequest.amount },
        },
      ],
    });
    issued.set(nonce, { message, depositAddress: depositAddress!, used: false });
    return json(res, 200, {
      correlationId: `fake-intent-${nonce.slice(0, 6)}`,
      intent: { standard: "nep413", payload: { recipient: verifier, nonce, message } },
    });
  }

  /** Checks what the verifier would: a good signature, an intent we issued, used once. Then the deposit "arrives". */
  function handleSubmitIntent(req: FakeRequest, res: ServerResponse) {
    const signed = (req.body?.signedData ?? {}) as SignedNep413Intent;
    if (req.body?.type !== "swap_transfer" || signed.standard !== "nep413" || !signed.payload) {
      return json(res, 400, { message: "signedData is malformed" });
    }
    const known = issued.get(signed.payload.nonce);
    if (!known || known.message !== signed.payload.message || signed.payload.recipient !== verifier) {
      return json(res, 400, { message: "intent was not issued by this service" });
    }
    if (known.used) return json(res, 400, { message: "nonce already used" });
    let valid = false;
    try {
      valid = verifyNep413(signed);
    } catch {
      valid = false;
    }
    if (!valid) return json(res, 400, { message: "invalid signature" });
    known.used = true;
    submitted.push(signed);
    const intentHash = `fakeintent${submitted.length}`;
    fake.setStatus(known.depositAddress, "PROCESSING", { intentHashes: [intentHash] });
    return json(res, 200, { intentHash, correlationId: `fake-submit-${submitted.length}` });
  }

  const server: Server = createServer((incoming: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (c: Buffer) => chunks.push(c));
    incoming.on("end", () => {
      const url = new URL(incoming.url ?? "/", "http://fake");
      const raw = Buffer.concat(chunks).toString();
      const req: FakeRequest = {
        method: incoming.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: incoming.headers,
        body: raw ? (JSON.parse(raw) as Record<string, any>) : undefined,
      };
      requests.push(req);

      const failure = failures.findIndex((f) => f.path === req.path);
      if (failure !== -1) {
        const [f] = failures.splice(failure, 1);
        return json(res, f!.status, f!.body);
      }
      if (req.method === "GET" && req.path === "/v0/tokens") return json(res, 200, tokensFixture);
      if (req.method === "POST" && req.path === "/v0/quote") return handleQuote(req, res);
      if (req.method === "GET" && req.path === "/v0/status") return handleStatus(req, res);
      if (req.method === "POST" && req.path === "/v0/deposit/submit") return handleDepositSubmit(req, res);
      if (req.method === "POST" && req.path === "/v0/generate-intent") return handleGenerateIntent(req, res);
      if (req.method === "POST" && req.path === "/v0/submit-intent") return handleSubmitIntent(req, res);
      return json(res, 404, { message: `Unexpected ${req.method} ${req.path}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const fake = {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** The signed intents submit-intent accepted, oldest first. */
    submitted,
    /** Requests to one path, oldest first. */
    to: (path: string) => requests.filter((r) => r.path === path),
    /** What /v0/status will report for a deposit address from now on. */
    setStatus(address: string, next: SwapStatus, swapDetails: SwapDetails = {}) {
      const stored = quotes.get(address);
      if (!stored) throw new Error(`fake 1Click has no quote for ${address}`);
      const defaults: SwapDetails =
        next === "SUCCESS"
          ? {
              amountOut: stored.quote.amountOut,
              ...txLink(address),
            }
          : {};
      statuses.set(address, { status: next, swapDetails: { ...defaults, ...swapDetails } });
    },
    /** Auto-pay transitions scheduled but not yet applied. */
    pendingAutoPay: () => pendingAutoPay,
    /** Make the next request to `path` fail with `status` and `body`. */
    failNext(path: string, failStatus: number, body: unknown = { message: "boom" }) {
      failures.push({ path, status: failStatus, body });
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        pendingAutoPay = 0;
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return fake;
}

export type FakeOneClick = Awaited<ReturnType<typeof startFakeOneClick>>;
