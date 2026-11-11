import { describe, expect, it } from "vitest";
import { OneClickError, createOneClickClient } from "../src/oneclick/client.js";
import type { GenerateIntentRequest, QuoteRequest, SubmitIntentRequest } from "../src/oneclick/types.js";
import quoteFixture from "./fixtures/quote-dry-exact-output.json" with { type: "json" };
import tokensFixture from "./fixtures/tokens.json" with { type: "json" };
import { fakeFetch } from "./helpers/fakeFetch.js";
import { failureOf } from "./helpers/failure.js";

const failure = (fn: () => unknown) => failureOf(OneClickError, fn);

const BASE = "https://1click.test";

describe("OneClickClient.tokens", () => {
  it("GETs /v0/tokens and returns the parsed list", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: tokensFixture }));
    const client = createOneClickClient({ baseUrl: BASE, fetch });

    const tokens = await client.tokens();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`${BASE}/v0/tokens`);
    expect(tokens).toHaveLength(tokensFixture.length);
    expect(tokens[0]).toMatchObject({ assetId: "nep141:wrap.near", blockchain: "near", symbol: "wNEAR" });
  });

  it("sends X-API-Key only when an API key is configured", async () => {
    const anon = fakeFetch(() => ({ body: [] }));
    await createOneClickClient({ baseUrl: BASE, fetch: anon.fetch }).tokens();
    expect(anon.calls[0]!.headers.has("x-api-key")).toBe(false);

    const keyed = fakeFetch(() => ({ body: [] }));
    await createOneClickClient({ baseUrl: BASE, apiKey: "jwt.abc.def", fetch: keyed.fetch }).tokens();
    expect(keyed.calls[0]!.headers.get("x-api-key")).toBe("jwt.abc.def");
  });
});

describe("OneClickClient requests", () => {
  const quoteRequest = quoteFixture.quoteRequest as unknown as QuoteRequest;

  it("quote POSTs the JSON request to /v0/quote and accepts HTTP 201", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 201, body: quoteFixture }));
    const client = createOneClickClient({ baseUrl: BASE, fetch });

    const res = await client.quote(quoteRequest);

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${BASE}/v0/quote`);
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    expect(calls[0]!.body).toEqual(quoteRequest);
    expect(res.quote.amountIn).toBe("5051529");
    expect(res.signature).toMatch(/^ed25519:/);
  });

  it("status GETs /v0/status with the deposit address URL-encoded", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { status: "PENDING_DEPOSIT" } }));
    const client = createOneClickClient({ baseUrl: BASE, fetch });

    await client.status({ depositAddress: "0xAbC/+= d" });

    expect(calls[0]!.method).toBe("GET");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v0/status");
    expect(url.searchParams.get("depositAddress")).toBe("0xAbC/+= d");
    expect(url.searchParams.has("depositMemo")).toBe(false);
  });

  it("status adds depositMemo only when the quote had one", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { status: "PENDING_DEPOSIT" } }));
    const client = createOneClickClient({ baseUrl: BASE, fetch });

    await client.status({ depositAddress: "GABC", depositMemo: "12345 & more" });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("depositAddress")).toBe("GABC");
    expect(url.searchParams.get("depositMemo")).toBe("12345 & more");
  });

  it("depositSubmit POSTs to /v0/deposit/submit", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { status: "KNOWN_DEPOSIT_TX" } }));
    const client = createOneClickClient({ baseUrl: BASE, fetch });

    const res = await client.depositSubmit({ txHash: "0xdead", depositAddress: "0xbeef" });

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${BASE}/v0/deposit/submit`);
    expect(calls[0]!.body).toEqual({ txHash: "0xdead", depositAddress: "0xbeef" });
    expect(res.status).toBe("KNOWN_DEPOSIT_TX");
  });

  it("generateIntent POSTs to /v0/generate-intent", async () => {
    const reply = {
      intent: { standard: "nep413", payload: { message: "m", nonce: "n", recipient: "intents.near" } },
      correlationId: "c",
    };
    const { fetch, calls } = fakeFetch(() => ({ body: reply }));
    const client = createOneClickClient({ baseUrl: BASE, fetch });
    const req: GenerateIntentRequest = {
      type: "swap_transfer",
      standard: "nep413",
      signerId: "shop-pay.near",
      depositAddress: "0xbeef",
    };

    const res = await client.generateIntent(req);

    expect(calls[0]!.url).toBe(`${BASE}/v0/generate-intent`);
    expect(calls[0]!.body).toEqual(req);
    expect(res).toEqual(reply);
  });

  it("submitIntent POSTs to /v0/submit-intent and returns the intent hash", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { intentHash: "H", correlationId: "c" } }));
    const client = createOneClickClient({ baseUrl: BASE, fetch });
    const req: SubmitIntentRequest = {
      type: "swap_transfer",
      signedData: {
        standard: "nep413",
        payload: { message: "m", nonce: "n", recipient: "intents.near" },
        public_key: "ed25519:PK",
        signature: "ed25519:SIG",
      },
    };

    const res = await client.submitIntent(req);

    expect(calls[0]!.url).toBe(`${BASE}/v0/submit-intent`);
    expect(calls[0]!.body).toEqual(req);
    expect(res.intentHash).toBe("H");
  });
});

describe("OneClickClient errors", () => {
  it("turns a 400 into OneClickError carrying status, server message, correlationId and body", async () => {
    const body = { message: "Amount is too low", correlationId: "corr-1" };
    const { fetch } = fakeFetch(() => ({ status: 400, body }));
    const client = createOneClickClient({ baseUrl: BASE, fetch });

    const err = await failure(() => client.tokens());

    expect(err.status).toBe(400);
    expect(err.message).toContain("Amount is too low");
    expect(err.correlationId).toBe("corr-1");
    expect(err.body).toEqual(body);
  });

  it("never puts the API key into an error", async () => {
    const { fetch } = fakeFetch(() => ({ status: 401, body: { message: "Unauthorized" } }));
    const client = createOneClickClient({ baseUrl: BASE, apiKey: "secretjwt", fetch });

    const err = await failure(() => client.quote(quoteFixture.quoteRequest as unknown as QuoteRequest));

    expect(err.status).toBe(401);
    expect(err.message).not.toContain("secretjwt");
    expect(JSON.stringify(err)).not.toContain("secretjwt");
  });

  it("copes with a non-JSON error body such as a gateway HTML page", async () => {
    const { fetch } = fakeFetch(() => ({ status: 502, text: "<html>Bad Gateway</html>" }));
    const err = await failure(() => createOneClickClient({ baseUrl: BASE, fetch }).tokens());
    expect(err.status).toBe(502);
    expect(err.message).toContain("Bad Gateway");
  });

  it("rejects a 2xx response whose body is not JSON", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, text: "not json" }));
    const err = await failure(() => createOneClickClient({ baseUrl: BASE, fetch }).tokens());
    expect(err.status).toBe(200);
    expect(err.message).toMatch(/not valid JSON/i);
  });

  it("wraps a network failure as status 0 so callers handle one error type", async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const err = await failure(() => createOneClickClient({ baseUrl: BASE, fetch }).tokens());
    expect(err.status).toBe(0);
    expect(err.message).toContain("fetch failed");
  });

  it("gives every request an abort signal so a hung server cannot hang the watcher", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: [] }));
    await createOneClickClient({ baseUrl: BASE, fetch }).tokens();
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });
});
