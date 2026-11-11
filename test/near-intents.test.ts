import { describe, expect, it } from "vitest";
import { NearRpcError, callView } from "../src/near/rpc.js";
import { getIntentsBalance, hasPublicKey } from "../src/near/intents.js";
import { failureOf } from "./helpers/failure.js";
import { fakeFetch } from "./helpers/fakeFetch.js";

const RPC = "https://rpc.example";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/** What a NEAR node answers for a successful view call returning `value` as JSON. */
const viewResult = (value: unknown) => ({
  body: { jsonrpc: "2.0", id: "tilll", result: { result: [...Buffer.from(JSON.stringify(value))], logs: [] } },
});

describe("callView", () => {
  it("POSTs a call_function query for the contract method and parses the JSON result", async () => {
    const { fetch, calls } = fakeFetch(() => viewResult("42"));

    const result = await callView({
      rpcUrl: RPC,
      contractId: "intents.near",
      method: "mt_balance_of",
      args: { account_id: "a.near", token_id: "x" },
      fetch,
    });

    expect(result).toBe("42");
    const call = calls[0]!;
    expect([call.method, call.url]).toEqual(["POST", RPC]);
    expect(call.body).toMatchObject({
      jsonrpc: "2.0",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: "intents.near",
        method_name: "mt_balance_of",
      },
    });
    const sent = (call.body as { params: { args_base64: string } }).params.args_base64;
    expect(JSON.parse(Buffer.from(sent, "base64").toString())).toEqual({ account_id: "a.near", token_id: "x" });
  });

  it("reports a contract error, such as a missing method, with the method name", async () => {
    const { fetch } = fakeFetch(() => ({
      body: { result: { error: "wasm execution failed with error: MethodResolveError(MethodNotFound)" } },
    }));
    const err = await failureOf(NearRpcError, () =>
      callView({ rpcUrl: RPC, contractId: "intents.near", method: "nope", args: {}, fetch }),
    );
    expect(err.message).toContain("nope");
    expect(err.message).toContain("MethodNotFound");
  });

  it("reports an RPC-level error", async () => {
    const { fetch } = fakeFetch(() => ({
      body: { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } },
    }));
    const err = await failureOf(NearRpcError, () =>
      callView({ rpcUrl: RPC, contractId: "nobody.near", method: "m", args: {}, fetch }),
    );
    expect(err.message).toMatch(/UNKNOWN_ACCOUNT|HANDLER_ERROR/);
  });

  it.each([
    ["a non-2xx HTTP status", () => ({ status: 503, text: "Service Unavailable" }), /HTTP 503/],
    ["a body that is not JSON", () => ({ text: "<html>nope</html>" }), /not JSON/],
    ["a response with neither result nor error", () => ({ body: { jsonrpc: "2.0" } }), /no result/],
  ])("reports %s", async (_name, respond, message) => {
    const { fetch } = fakeFetch(respond);
    const err = await failureOf(NearRpcError, () =>
      callView({ rpcUrl: RPC, contractId: "c", method: "m", args: {}, fetch }),
    );
    expect(err.message).toMatch(message);
  });

  it("wraps a network failure", async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const err = await failureOf(NearRpcError, () =>
      callView({ rpcUrl: RPC, contractId: "c", method: "m", args: {}, fetch }),
    );
    expect(err.message).toContain("fetch failed");
  });

  it("gives every call a timeout", async () => {
    const { fetch, calls } = fakeFetch(() => viewResult(1));
    await callView({ rpcUrl: RPC, contractId: "c", method: "m", args: {}, fetch });
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("getIntentsBalance", () => {
  it("asks intents.near for mt_balance_of with the 1Click asset id as the token id", async () => {
    const { fetch, calls } = fakeFetch(() => viewResult("5000000"));

    const balance = await getIntentsBalance({ rpcUrl: RPC, accountId: "shop-pay.near", tokenId: USDC, fetch });

    expect(balance).toBe("5000000");
    const params = (calls[0]!.body as { params: { account_id: string; method_name: string; args_base64: string } })
      .params;
    expect([params.account_id, params.method_name]).toEqual(["intents.near", "mt_balance_of"]);
    expect(JSON.parse(Buffer.from(params.args_base64, "base64").toString())).toEqual({
      account_id: "shop-pay.near",
      token_id: USDC,
    });
  });

  it("refuses an answer that is not a plain integer string", async () => {
    const { fetch } = fakeFetch(() => viewResult({ surprise: true }));
    const err = await failureOf(NearRpcError, () =>
      getIntentsBalance({ rpcUrl: RPC, accountId: "a.near", tokenId: USDC, fetch }),
    );
    expect(err.message).toMatch(/did not return a balance/);
  });
});

const contractOf = (call: { body: unknown }) => (call.body as { params: { account_id: string } }).params.account_id;

describe("a different verifier contract (a testnet)", () => {
  const TESTNET_VERIFIER = "verifier.tidepool-sandbox.testnet";

  it("asks the contract it is given for the balance, and names it in errors", async () => {
    const ok = fakeFetch(() => viewResult("100000000"));
    expect(
      await getIntentsBalance({
        rpcUrl: RPC,
        accountId: "a.testnet",
        tokenId: USDC,
        contractId: TESTNET_VERIFIER,
        fetch: ok.fetch,
      }),
    ).toBe("100000000");
    expect(contractOf(ok.calls[0]!)).toBe(TESTNET_VERIFIER);

    const bad = fakeFetch(() => viewResult(null));
    const err = await failureOf(NearRpcError, () =>
      getIntentsBalance({
        rpcUrl: RPC,
        accountId: "a.testnet",
        tokenId: USDC,
        contractId: TESTNET_VERIFIER,
        fetch: bad.fetch,
      }),
    );
    expect(err.message).toContain(`${TESTNET_VERIFIER}.mt_balance_of`);
  });

  it("asks the contract it is given whether a key is registered", async () => {
    const { fetch, calls } = fakeFetch(() => viewResult(true));
    await hasPublicKey({
      rpcUrl: RPC,
      accountId: "a.testnet",
      publicKey: "ed25519:K",
      contractId: TESTNET_VERIFIER,
      fetch,
    });
    expect(contractOf(calls[0]!)).toBe(TESTNET_VERIFIER);
  });

  it("defaults to intents.near when no contract is given", async () => {
    const { fetch, calls } = fakeFetch(() => viewResult("1"));
    await getIntentsBalance({ rpcUrl: RPC, accountId: "a.near", tokenId: USDC, fetch });
    expect(contractOf(calls[0]!)).toBe("intents.near");
  });
});

describe("hasPublicKey", () => {
  it("reports whether a key is registered for the account on intents.near", async () => {
    const yes = fakeFetch(() => viewResult(true));
    const no = fakeFetch(() => viewResult(false));

    expect(await hasPublicKey({ rpcUrl: RPC, accountId: "a.near", publicKey: "ed25519:K", fetch: yes.fetch })).toBe(
      true,
    );
    expect(await hasPublicKey({ rpcUrl: RPC, accountId: "a.near", publicKey: "ed25519:K", fetch: no.fetch })).toBe(
      false,
    );

    const params = (yes.calls[0]!.body as { params: { method_name: string; args_base64: string } }).params;
    expect(params.method_name).toBe("has_public_key");
    expect(JSON.parse(Buffer.from(params.args_base64, "base64").toString())).toEqual({
      account_id: "a.near",
      public_key: "ed25519:K",
    });
  });

  it("refuses a non-boolean answer", async () => {
    const { fetch } = fakeFetch(() => viewResult("maybe"));
    const err = await failureOf(NearRpcError, () =>
      hasPublicKey({ rpcUrl: RPC, accountId: "a.near", publicKey: "ed25519:K", fetch }),
    );
    expect(err.message).toMatch(/true or false/);
  });
});
