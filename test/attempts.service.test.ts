import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { failureOf } from "./helpers/failure.js";
import { OneClickError } from "../src/oneclick/client.js";
import { TOKENS, USDC_BASE, USDC_NEAR, makeWorld, quoteResponseFor, REFUND_ADDRESS } from "./helpers/world.js";

const MINUTE = 60_000;
const input = { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS };
const SOL_USDC = TOKENS.find((t) => t.blockchain === "sol" && t.symbol === "USDC")!.assetId;
const STELLAR_USDC = TOKENS.find((t) => t.blockchain === "stellar" && t.symbol === "USDC")!.assetId;

const failure = (fn: () => unknown) => failureOf(ApiError, fn);

describe("createAttempt", () => {
  it("asks 1Click for the PLAN section 8 EXACT_OUTPUT quote and stores the attempt", async () => {
    const { service, client, clock } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });

    const att = await service.createAttempt(inv.id, input);

    expect(client.quote).toHaveBeenCalledTimes(1);
    expect(client.quote.mock.calls[0]![0]).toEqual({
      dry: false,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: USDC_BASE,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: USDC_NEAR,
      amount: "5000000",
      refundTo: REFUND_ADDRESS,
      refundType: "ORIGIN_CHAIN",
      recipient: "shop-pay.near",
      recipientType: "INTENTS",
      deadline: new Date(clock.now().getTime() + 30 * MINUTE).toISOString(),
      depositMode: "SIMPLE",
      referral: "tilll",
    });
    expect(att).toMatchObject({
      invoiceId: inv.id,
      originAsset: USDC_BASE,
      originChain: "base",
      originSymbol: "USDC",
      originDecimals: 6,
      refundTo: REFUND_ADDRESS,
      depositAddress: "0xDEPOSIT1",
      depositMemo: null,
      amountIn: "5051529",
      minAmountIn: "5001013",
      deadline: new Date(clock.now().getTime() + 30 * MINUTE).toISOString(),
      oneclickStatus: "PENDING_DEPOSIT",
      status: "awaiting",
      statusResponse: null,
      depositTxHash: null,
    });
    expect(att.id).toMatch(/^att_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(att.quote.signature).toBe("ed25519:SIG1");
    expect(service.getAttempt(att.id)).toEqual(att);
  });

  it("shows the payer the deadline we asked for, not the later time 1Click keeps the address alive until", async () => {
    const { service, clock } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });

    const att = await service.createAttempt(inv.id, input);

    const asked = new Date(clock.now().getTime() + 30 * MINUTE).toISOString();
    expect(att.deadline).toBe(asked);
    expect(att.quote.quote.timeWhenInactive).not.toBe(asked); // 1Click's own field is days later
  });

  it("keeps the deposit memo when 1Click returns one", async () => {
    const { service, client } = makeWorld();
    client.quote.mockImplementationOnce(async (req) => quoteResponseFor(req, 1, { depositMemo: "987654" }));
    const inv = service.createInvoice({ amount: "5" });
    expect((await service.createAttempt(inv.id, input)).depositMemo).toBe("987654");
  });

  it("is a 404 for an unknown invoice and never asks 1Click for a quote", async () => {
    const { service, client } = makeWorld();
    expect(await failure(() => service.createAttempt("inv_nope", input))).toMatchObject({ status: 404 });
    expect(client.quote).not.toHaveBeenCalled();
  });

  it.each(["canceled", "paid", "expired"])("refuses a %s invoice", async (status) => {
    const { service, client, db } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    db.prepare("UPDATE invoices SET status = ?").run(status);
    expect(await failure(() => service.createAttempt(inv.id, input))).toMatchObject({
      status: 409,
      code: "invoice_not_open",
    });
    expect(client.quote).not.toHaveBeenCalled();
  });

  it("refuses an open invoice whose expiry time has passed, even before the sweep marks it expired", async () => {
    const { service, client, clock } = makeWorld();
    const inv = service.createInvoice({ amount: "5", expiresInMinutes: 10 });
    clock.advance(10 * MINUTE);
    expect(await failure(() => service.createAttempt(inv.id, input))).toMatchObject({
      status: 409,
      code: "invoice_expired",
    });
    expect(client.quote).not.toHaveBeenCalled();
  });

  it("rejects an asset that 1Click does not list", async () => {
    const { service, client } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    expect(await failure(() => service.createAttempt(inv.id, { ...input, originAsset: "nep141:nope" }))).toMatchObject({
      status: 400,
      code: "unsupported_asset",
    });
    expect(client.quote).not.toHaveBeenCalled();
  });

  it.each([
    ["a malformed EVM address", USDC_BASE, "0x123", /0x/],
    ["an EVM address on a Solana asset", SOL_USDC, "0x1111111111111111111111111111111111111111", /Solana/],
  ])("refuses %s before asking 1Click", async (_name, originAsset, refundTo, reason) => {
    const { service, client } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    const err = await failure(() => service.createAttempt(inv.id, { originAsset, refundTo }));
    expect(err).toMatchObject({ status: 400, code: "invalid_refund_address" });
    expect(err.message).toMatch(reason);
    expect(client.quote).not.toHaveBeenCalled();
  });

  it("lets a chain without a strict rule through with just the generic check, leaving the rest to 1Click", async () => {
    const { service, client } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    await service.createAttempt(inv.id, { originAsset: STELLAR_USDC, refundTo: "G-anything-without-spaces" });
    expect(client.quote).toHaveBeenCalledTimes(1);
  });

  it("rejects a blank refund address", async () => {
    const { service, client } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    expect(await failure(() => service.createAttempt(inv.id, { ...input, refundTo: "   " }))).toMatchObject({
      status: 400,
      code: "invalid_refund_address",
    });
    expect(client.quote).not.toHaveBeenCalled();
  });
});

describe("superseding", () => {
  it("supersedes the earlier awaiting attempt once a new quote exists", async () => {
    const { service } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    const first = await service.createAttempt(inv.id, input);
    const second = await service.createAttempt(inv.id, input);

    expect(service.getAttempt(first.id).status).toBe("superseded");
    expect(service.getAttempt(second.id).status).toBe("awaiting");
  });

  it("keeps the earlier attempt usable when the new quote fails", async () => {
    const { service, client } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    const first = await service.createAttempt(inv.id, input);

    client.quote.mockRejectedValueOnce(new OneClickError(400, "Quoting for this pair is not available"));
    await failure(() => service.createAttempt(inv.id, input));

    expect(service.getAttempt(first.id).status).toBe("awaiting");
  });

  it("leaves attempts that already have money on them alone", async () => {
    const { service, db } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    const first = await service.createAttempt(inv.id, input);
    db.prepare("UPDATE attempts SET status = 'confirming' WHERE id = ?").run(first.id);

    await service.createAttempt(inv.id, input);

    expect(service.getAttempt(first.id).status).toBe("confirming");
  });

  it("does not create an attempt when the invoice got paid while the quote was in flight", async () => {
    const { service, client, db } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    client.quote.mockImplementationOnce(async (req) => {
      db.prepare("UPDATE invoices SET status = 'paid'").run();
      return quoteResponseFor(req, 1);
    });

    expect(await failure(() => service.createAttempt(inv.id, input))).toMatchObject({
      status: 409,
      code: "invoice_not_open",
    });
    expect(db.prepare("SELECT count(*) AS n FROM attempts").get()).toEqual({ n: 0 });
  });
});

describe("attempt limit", () => {
  it("allows 5 attempts per invoice per 10 minutes, then 429s without asking 1Click", async () => {
    const { service, client, clock } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });

    for (let i = 0; i < 5; i++) await service.createAttempt(inv.id, input);
    expect(await failure(() => service.createAttempt(inv.id, input))).toMatchObject({
      status: 429,
      code: "too_many_attempts",
    });
    expect(client.quote).toHaveBeenCalledTimes(5);

    clock.advance(10 * MINUTE + 1);
    await service.createAttempt(inv.id, input);
    expect(client.quote).toHaveBeenCalledTimes(6);
  });

  it("counts per invoice, not globally", async () => {
    const { service } = makeWorld();
    const a = service.createInvoice({ amount: "5" });
    const b = service.createInvoice({ amount: "5" });
    for (let i = 0; i < 5; i++) await service.createAttempt(a.id, input);
    await expect(service.createAttempt(b.id, input)).resolves.toBeDefined();
  });
});

describe("1Click errors", () => {
  it.each([
    [
      new OneClickError(400, "1Click POST /v0/quote failed (400): refundTo is not valid"),
      400,
      "invalid_refund_address",
    ],
    [
      new OneClickError(400, "1Click POST /v0/quote failed (400): Quoting for this pair is not available"),
      422,
      "pair_unavailable",
    ],
    [new OneClickError(400, "1Click POST /v0/quote failed (400): Amount is too low"), 422, "quote_rejected"],
    [new OneClickError(0, "1Click POST /v0/quote failed: fetch failed"), 503, "upstream_unavailable"],
    [new OneClickError(500, "1Click POST /v0/quote failed (500): boom"), 502, "upstream_error"],
    [new OneClickError(401, "1Click POST /v0/quote failed (401): Unauthorized"), 502, "upstream_error"],
  ])("maps %s to %i %s", async (upstream, status, code) => {
    const { service, client } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    client.quote.mockRejectedValueOnce(upstream);

    const err = await failure(() => service.createAttempt(inv.id, input));

    expect(err).toMatchObject({ status, code });
    // Our own sentence, with no provider names. Only a rejected quote adds the reason (for example a minimum).
    expect(err.message).not.toMatch(/1Click|POST|v0/);
    expect(err.message).toContain(code === "quote_rejected" ? "Amount is too low" : "");
  });

  it("tells the payer the minimum in the token they pay with, not in raw base units", async () => {
    const { service, client } = makeWorld();
    const inv = service.createInvoice({ amount: "0.1" });
    client.quote.mockRejectedValueOnce(
      new OneClickError(400, "1Click POST /v0/quote failed (400): Amount is too low for bridge, try at least 149983"),
    );

    const err = await failure(() => service.createAttempt(inv.id, input));

    expect(err).toMatchObject({ status: 422, code: "amount_too_low" });
    expect(err.message).toContain("about 0.149983 USDC");
    expect(err.message).not.toContain("149983,");
  });

  it("does not store an attempt when 1Click returns no deposit address", async () => {
    const { service, client, db } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    client.quote.mockImplementationOnce(async (req) => {
      const q = quoteResponseFor(req, 1);
      delete q.quote.depositAddress;
      return q;
    });

    expect(await failure(() => service.createAttempt(inv.id, input))).toMatchObject({
      status: 502,
      code: "upstream_error",
    });
    expect(db.prepare("SELECT count(*) AS n FROM attempts").get()).toEqual({ n: 0 });
  });

  it("refuses a quote that is for another account, asset, amount or address than it asked for", async () => {
    for (const change of [
      { recipient: "someone-else.near" },
      { destinationAsset: USDC_BASE },
      { amount: "1" },
      { refundTo: "0x2222222222222222222222222222222222222222" },
      { recipientType: "DESTINATION_CHAIN" as const },
    ]) {
      const { service, client, db } = makeWorld();
      const inv = service.createInvoice({ amount: "5" });
      client.quote.mockImplementationOnce(async (req) => {
        const q = quoteResponseFor(req, 1);
        Object.assign(q.quoteRequest, change);
        return q;
      });

      const refused = await failure(() => service.createAttempt(inv.id, input));

      expect(refused).toMatchObject({ status: 502, code: "upstream_error" });
      expect(refused.message).toContain(Object.keys(change)[0]);
      expect(db.prepare("SELECT count(*) AS n FROM attempts").get()).toEqual({ n: 0 });
    }
  });

  it("accepts an EVM refund address echoed in another letter case", async () => {
    const { service, client } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    const mixed = "0xAbCdEf0000000000000000000000000000AbCdEf";
    client.quote.mockImplementationOnce(async (req) => {
      const q = quoteResponseFor(req, 1);
      q.quoteRequest.refundTo = mixed.toLowerCase();
      return q;
    });

    const att = await service.createAttempt(inv.id, { originAsset: USDC_BASE, refundTo: mixed });

    expect(att.status).toBe("awaiting");
  });

  it("does not leak non-OneClick errors as ApiErrors", async () => {
    const { service, client } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    client.quote.mockRejectedValueOnce(new TypeError("a bug"));
    await expect(service.createAttempt(inv.id, input)).rejects.toThrow(TypeError);
  });
});

const modes = (client: ReturnType<typeof makeWorld>["client"]) => client.quote.mock.calls.map((c) => c[0].depositMode);
const wrongMode = (chain: string) =>
  new OneClickError(
    400,
    `1Click POST /v0/quote failed (400): Incorrect depositMode for originAsset from ${chain} chain`,
  );

describe("deposit mode retry", () => {
  it("retries once with MEMO when 1Click says SIMPLE is wrong for the chain", async () => {
    const { service, client } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    client.quote.mockRejectedValueOnce(wrongMode("base"));

    const att = await service.createAttempt(inv.id, input);

    expect(modes(client)).toEqual(["SIMPLE", "MEMO"]);
    expect(att.status).toBe("awaiting");
  });

  it("retries once with SIMPLE when a configured memo chain turns out not to need one", async () => {
    const { service, client } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    client.quote.mockRejectedValueOnce(wrongMode("stellar"));

    await service.createAttempt(inv.id, { originAsset: STELLAR_USDC, refundTo: "G123" });

    expect(modes(client)).toEqual(["MEMO", "SIMPLE"]);
  });

  it("gives up after one retry and reports the error", async () => {
    const { service, client } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    client.quote.mockRejectedValue(wrongMode("base"));

    expect(await failure(() => service.createAttempt(inv.id, input))).toMatchObject({
      status: 422,
      code: "quote_rejected",
    });
    expect(client.quote).toHaveBeenCalledTimes(2);
  });

  it("does not retry unrelated rejections", async () => {
    const { service, client } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    client.quote.mockRejectedValueOnce(new OneClickError(400, "1Click POST /v0/quote failed (400): Amount is too low"));

    await failure(() => service.createAttempt(inv.id, input));

    expect(client.quote).toHaveBeenCalledTimes(1);
  });
});

describe("getAttempt", () => {
  it("is a 404 for an unknown id", async () => {
    const { service } = makeWorld();
    expect(await failure(() => service.getAttempt("att_nope"))).toMatchObject({ status: 404, code: "not_found" });
  });
});
