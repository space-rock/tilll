import { describe, expect, it } from "vitest";
import { TilllApiError, createApi } from "../widget/src/api.js";
import { fakeFetch } from "./helpers/fakeFetch.js";

const ORIGIN = "https://pay.example.com";

async function failure(fn: () => Promise<unknown>): Promise<TilllApiError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof TilllApiError) return e;
    throw e;
  }
  throw new Error("expected a TilllApiError but the call succeeded");
}

describe("widget api", () => {
  it("GETs the invoice, tokens and attempt from the server origin", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { ok: true } }));
    const api = createApi({ origin: ORIGIN, fetch });

    await api.invoice("inv_1");
    await api.tokens();
    await api.attempt("att_1");

    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", `${ORIGIN}/pay/invoices/inv_1`],
      ["GET", `${ORIGIN}/pay/tokens`],
      ["GET", `${ORIGIN}/pay/attempts/att_1`],
    ]);
  });

  it("POSTs a new attempt as JSON", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 201, body: { id: "att_1" } }));
    const api = createApi({ origin: ORIGIN, fetch });

    const res = await api.createAttempt("inv_1", { originAsset: "nep141:x", refundTo: "0xabc" });

    expect(res).toEqual({ id: "att_1" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${ORIGIN}/pay/invoices/inv_1/attempts`);
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    expect(calls[0]!.body).toEqual({ originAsset: "nep141:x", refundTo: "0xabc" });
  });

  it("encodes ids so they cannot change the path", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }));
    await createApi({ origin: ORIGIN, fetch }).invoice("a/../b?x=1");
    expect(calls[0]!.url).toBe(`${ORIGIN}/pay/invoices/a%2F..%2Fb%3Fx%3D1`);
  });

  it("strips a trailing slash from the origin", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }));
    await createApi({ origin: `${ORIGIN}/`, fetch }).tokens();
    expect(calls[0]!.url).toBe(`${ORIGIN}/pay/tokens`);
  });

  it("turns the server's error shape into a TilllApiError", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 400,
      body: { error: { code: "invalid_refund_address", message: "A Solana address is 32 to 44 characters." } },
    }));
    const err = await failure(() =>
      createApi({ origin: ORIGIN, fetch }).createAttempt("inv_1", { originAsset: "a", refundTo: "b" }),
    );
    expect(err).toMatchObject({
      status: 400,
      code: "invalid_refund_address",
      message: "A Solana address is 32 to 44 characters.",
    });
  });

  it("reports an unreachable server as code network", async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const err = await failure(() => createApi({ origin: ORIGIN, fetch }).tokens());
    expect(err).toMatchObject({ status: 0, code: "network" });
  });

  it("reports a non-JSON answer, such as a proxy error page, as code bad_response", async () => {
    const { fetch } = fakeFetch(() => ({ status: 502, text: "<html>Bad Gateway</html>" }));
    const err = await failure(() => createApi({ origin: ORIGIN, fetch }).tokens());
    expect(err).toMatchObject({ status: 502, code: "bad_response" });
  });

  it("gives every request a timeout signal", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }));
    await createApi({ origin: ORIGIN, fetch }).tokens();
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });
});
