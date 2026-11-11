import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createController, type ControllerState } from "../widget/src/controller.js";
import type { TokensPayload } from "../widget/src/tokens.js";
import type { InvoiceStatus, PublicAttempt, PublicInvoice } from "../widget/src/types.js";
import { USDC_BASE } from "./helpers/oneclickData.js";
import { EVM, SOL_USDC, apiError, attempt, invoice, payload } from "./helpers/widgetData.js";

function setup(
  overrides: { invoice?: () => Promise<PublicInvoice>; createAttempt?: () => Promise<PublicAttempt> } = {},
) {
  const api = {
    invoice: vi.fn<() => Promise<PublicInvoice>>(overrides.invoice ?? (async () => invoice())),
    tokens: vi.fn<() => Promise<TokensPayload>>(async () => payload),
    createAttempt: vi.fn<(id: string, body: { originAsset: string; refundTo: string }) => Promise<PublicAttempt>>(
      overrides.createAttempt ?? (async () => attempt()),
    ),
    attempt: vi.fn<(id: string) => Promise<PublicAttempt>>(async () => attempt()),
  };
  const onPaid = vi.fn<(a: PublicAttempt) => void>();
  const controller = createController({ api, invoiceId: "inv_1", onPaid, pollMs: 3000 });
  const state = (): ControllerState => controller.getState();
  return { api, controller, onPaid, state };
}

/** The network a token is on, as the widget lists it. */
const chainOf = (assetId: string) =>
  Object.entries(payload.chains).find(([, tokens]) => tokens.some((t) => t.assetId === assetId))![0];

/** Open the network list, choose the token's network, then the token. */
function choose(controller: ReturnType<typeof setup>["controller"], assetId: string) {
  controller.start();
  controller.pickNetwork(chainOf(assetId));
  controller.pickToken(assetId);
}

/** Load, choose a network and a token, and type an address. */
async function atAddressStep(assetId = USDC_BASE, address = EVM) {
  const s = setup();
  await s.controller.loaded;
  choose(s.controller, assetId);
  s.controller.setRefundTo(address);
  return s;
}

/** Everything up to a created attempt, polling started. */
async function atPayStep() {
  const s = await atAddressStep();
  await s.controller.submitAddress();
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("loading", () => {
  it("fetches the invoice and the token list once and shows the summary for an open invoice", async () => {
    const { controller, api, state } = setup();
    expect(state().step).toBe("loading");

    await controller.loaded;

    expect(state().step).toBe("summary");
    expect(state().invoice).toMatchObject({ id: "inv_1", amount: "5" });
    expect(state().choices.map((c) => c.chain)).toContain("base");
    expect(api.invoice).toHaveBeenCalledTimes(1);
    expect(api.tokens).toHaveBeenCalledTimes(1);
  });

  it("goes straight to paid for an invoice that is already paid", async () => {
    const { controller, state } = setup({ invoice: async () => invoice("paid") });
    await controller.loaded;
    expect(state().step).toBe("paid");
    expect(state().attempt).toBeNull();
  });

  it.each([
    ["expired", "expired"],
    ["canceled", "canceled"],
  ] as const)("shows a %s invoice as unavailable", async (status, kind) => {
    const { controller, state } = setup({ invoice: async () => invoice(status) });
    await controller.loaded;
    expect(state().step).toBe("unavailable");
    expect(state().unavailable?.kind).toBe(kind);
  });

  it("explains an unknown invoice", async () => {
    const { controller, state } = setup({
      invoice: async () => {
        throw apiError(404, "not_found", "No invoice inv_1");
      },
    });
    await controller.loaded;
    expect(state().unavailable?.kind).toBe("not_found");
  });

  it("offers a retry after a network failure, and recovers", async () => {
    let fail = true;
    const { controller, state, api } = setup({
      invoice: async () => {
        if (fail) throw apiError(0, "network", "Could not reach the payment server.");
        return invoice();
      },
    });
    await controller.loaded;
    expect(state().unavailable).toMatchObject({ kind: "error", message: "Could not reach the payment server." });

    fail = false;
    await controller.retry();

    expect(state().step).toBe("summary");
    expect(api.invoice).toHaveBeenCalledTimes(2);
  });
});

describe("choosing a network, then a token", () => {
  it("moves summary to the network list and back", async () => {
    const { controller, state } = setup();
    await controller.loaded;
    controller.start();
    expect(state().step).toBe("network");
    expect(
      state()
        .visibleChains.map((c) => c.chain)
        .slice(0, 4),
    ).toEqual(["base", "arb", "eth", "sol"]);
    controller.back();
    expect(state().step).toBe("summary");
  });

  it("narrows the networks by search without losing the full list, and clears the search when one is chosen", async () => {
    const { controller, state } = setup();
    await controller.loaded;
    controller.start();
    const all = state().visibleChains.length;

    controller.setSearch("sol");
    expect(state().visibleChains.map((c) => c.chain)).toEqual(["sol"]);
    controller.setSearch("");
    expect(state().visibleChains).toHaveLength(all);

    controller.setSearch("arb");
    controller.pickNetwork("arb");
    expect(state()).toMatchObject({ step: "token", search: "" });
  });

  it("shows that network's tokens, and narrows them by search", async () => {
    const { controller, state } = setup();
    await controller.loaded;
    controller.start();
    controller.pickNetwork("base");

    expect(state().network?.chain).toBe("base");
    expect(state().visibleTokens.length).toBeGreaterThan(1);
    expect(state().visibleTokens.every((t) => payload.chains["base"]!.some((x) => x.assetId === t.assetId))).toBe(true);

    controller.setSearch("usdc");
    expect(state().visibleTokens.length).toBeGreaterThan(0);
    expect(state().visibleTokens.every((t) => /usdc/i.test(t.symbol))).toBe(true);
    controller.setSearch("");
    expect(state().visibleTokens.length).toBe(payload.chains["base"]!.length);
  });

  it("ignores a network that is not on offer", async () => {
    const { controller, state } = setup();
    await controller.loaded;
    controller.start();
    controller.pickNetwork("nowhere");
    expect(state()).toMatchObject({ step: "network", network: null });
  });

  it("picking a token moves on to the refund address step with that token selected", async () => {
    const { controller, state } = setup();
    await controller.loaded;
    choose(controller, USDC_BASE);

    expect(state().step).toBe("address");
    expect(state().selected).toMatchObject({
      chain: { chain: "base", name: "Base" },
      token: { symbol: "USDC", assetId: USDC_BASE },
    });
  });

  it("ignores a token that is not on the chosen network", async () => {
    const { controller, state } = setup();
    await controller.loaded;
    controller.start();
    controller.pickToken(USDC_BASE); // no network chosen yet
    expect(state().step).toBe("network");
    controller.pickNetwork("sol");
    controller.pickToken(USDC_BASE); // a Base token on the Solana list
    expect(state().step).toBe("token");
    controller.pickToken("nep141:nope");
    expect(state().step).toBe("token");
  });

  it("goes back one step at a time: address, token, network, summary", async () => {
    const { controller, state } = setup();
    await controller.loaded;
    choose(controller, USDC_BASE);
    controller.back();
    expect(state()).toMatchObject({ step: "token", network: { chain: "base" } });
    controller.back();
    expect(state()).toMatchObject({ step: "network", network: null });
    controller.back();
    expect(state().step).toBe("summary");
  });
});

describe("refund address", () => {
  it("validates against the chosen chain as the payer types, ignoring surrounding spaces", async () => {
    const { controller, state } = await atAddressStep();
    expect(state().addressCheck).toEqual({ ok: true, strict: true });

    controller.setRefundTo(`  ${EVM}  `);
    expect(state().addressCheck).toEqual({ ok: true, strict: true });

    controller.setRefundTo("0x123");
    expect(state().addressCheck?.ok).toBe(false);
  });

  it("re-checks the same text when the payer switches to a different chain", async () => {
    const { controller, state } = await atAddressStep();
    controller.back(); // to the token list
    controller.back(); // to the network list
    controller.pickNetwork("sol");
    controller.pickToken(SOL_USDC);
    expect(state().refundTo).toBe(EVM);
    expect(state().addressCheck?.ok).toBe(false);
  });

  it("does not show an error until the payer submits, and does not call the server with a bad address", async () => {
    const { controller, state, api } = await atAddressStep(USDC_BASE, "0x123");
    expect(state().showAddressError).toBe(false);

    await controller.submitAddress();

    expect(state().showAddressError).toBe(true);
    expect(state().step).toBe("address");
    expect(api.createAttempt).not.toHaveBeenCalled();
  });

  it("goes back to the token list of the same network", async () => {
    const { controller, state } = await atAddressStep();
    controller.back();
    expect(state().step).toBe("token");
    expect(state().network?.chain).toBe("base");
  });
});

describe("creating the attempt", () => {
  it("sends the chosen asset and the trimmed address, then shows the payment details", async () => {
    const { controller, state, api } = await atAddressStep(USDC_BASE, `  ${EVM} `);

    await controller.submitAddress();

    expect(api.createAttempt).toHaveBeenCalledWith("inv_1", { originAsset: USDC_BASE, refundTo: EVM });
    expect(state().step).toBe("pay");
    expect(state().attempt).toMatchObject({ status: "awaiting", amountIn: "5.051529" });
    expect(state().submitting).toBe(false);
  });

  it("ignores a second click while the first is still in flight", async () => {
    const { controller, api } = await atAddressStep();
    const first = controller.submitAddress();
    const second = controller.submitAddress();
    await Promise.all([first, second]);
    expect(api.createAttempt).toHaveBeenCalledTimes(1);
  });

  it("keeps the payer on the address step, with the server's message, when the address is refused", async () => {
    const s = setup({
      createAttempt: async () => {
        throw apiError(400, "invalid_refund_address", "refundTo is not valid");
      },
    });
    await s.controller.loaded;
    choose(s.controller, USDC_BASE);
    s.controller.setRefundTo(EVM);

    await s.controller.submitAddress();

    expect(s.state()).toMatchObject({
      step: "address",
      error: "refundTo is not valid",
      showAddressError: true,
      submitting: false,
    });
  });

  it("sends the payer back to the token list when 1Click cannot quote that token", async () => {
    const s = setup({
      createAttempt: async () => {
        throw apiError(422, "pair_unavailable", "Quoting for this pair is not available");
      },
    });
    await s.controller.loaded;
    choose(s.controller, USDC_BASE);
    s.controller.setRefundTo(EVM);

    await s.controller.submitAddress();

    expect(s.state()).toMatchObject({ step: "token", error: "Quoting for this pair is not available" });
  });

  it("shows other failures on the address step so the payer can try again", async () => {
    const s = setup({
      createAttempt: async () => {
        throw apiError(429, "too_many_attempts", "Too many payment attempts for this invoice. Wait a few minutes.");
      },
    });
    await s.controller.loaded;
    choose(s.controller, USDC_BASE);
    s.controller.setRefundTo(EVM);
    await s.controller.submitAddress();
    expect(s.state()).toMatchObject({ step: "address", error: expect.stringContaining("Too many") });
  });

  it("re-reads the invoice when the server says it can no longer be paid", async () => {
    let status: InvoiceStatus = "open";
    const s = setup({
      invoice: async () => invoice(status),
      createAttempt: async () => {
        status = "expired";
        throw apiError(409, "invoice_expired", "Invoice inv_1 has expired.");
      },
    });
    await s.controller.loaded;
    choose(s.controller, USDC_BASE);
    s.controller.setRefundTo(EVM);

    await s.controller.submitAddress();

    expect(s.state().step).toBe("unavailable");
    expect(s.state().unavailable?.kind).toBe("expired");
  });
});

describe("watching the payment", () => {
  it("polls the attempt every 3 seconds and follows it to paid, calling onPaid once", async () => {
    const { controller, state, api, onPaid } = await atPayStep();
    const id = state().attempt!.id;
    api.attempt
      .mockResolvedValueOnce(attempt("awaiting", "open", id))
      .mockResolvedValueOnce(attempt("confirming", "open", id))
      .mockResolvedValue({
        ...attempt("paid", "paid", id),
        txLinks: [{ hash: "0xabc", explorerUrl: "https://basescan.org/tx/0xabc" }],
      });

    await vi.advanceTimersByTimeAsync(3000);
    expect(state().attempt?.status).toBe("awaiting");
    await vi.advanceTimersByTimeAsync(3000);
    expect(state().attempt?.status).toBe("confirming");
    expect(state().step).toBe("pay");
    await vi.advanceTimersByTimeAsync(3000);

    expect(state().step).toBe("paid");
    expect(state().attempt?.txLinks).toHaveLength(1);
    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(onPaid.mock.calls[0]![0].id).toBe(id);

    const calls = api.attempt.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.attempt.mock.calls.length).toBe(calls);
    expect(controller.getState().step).toBe("paid");
  });

  it.each(["refunded", "failed"] as const)(
    "stops polling once the attempt is %s but keeps the details on screen",
    async (status) => {
      const { state, api } = await atPayStep();
      const id = state().attempt!.id;
      api.attempt.mockResolvedValue(attempt(status, "open", id));

      await vi.advanceTimersByTimeAsync(3000);
      expect(state()).toMatchObject({ step: "pay", attempt: { status } });

      const calls = api.attempt.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(api.attempt.mock.calls.length).toBe(calls);
    },
  );

  it("keeps polling an underpaid attempt, since it may still be topped up or refunded", async () => {
    const { state, api } = await atPayStep();
    const id = state().attempt!.id;
    api.attempt.mockResolvedValue(attempt("underpaid", "open", id));
    await vi.advanceTimersByTimeAsync(9000);
    expect(api.attempt.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(state().attempt?.status).toBe("underpaid");
  });

  it("flags a connection problem, keeps trying, and clears the flag when it works again", async () => {
    const { state, api } = await atPayStep();
    const id = state().attempt!.id;
    api.attempt.mockRejectedValueOnce(apiError(0, "network")).mockResolvedValue(attempt("confirming", "open", id));

    await vi.advanceTimersByTimeAsync(3000);
    expect(state().connectionIssue).toBe(true);
    expect(state().step).toBe("pay");

    await vi.advanceTimersByTimeAsync(3000);
    expect(state().connectionIssue).toBe(false);
    expect(state().attempt?.status).toBe("confirming");
  });

  it("shows paid, without calling onPaid, when the invoice was settled through a different attempt", async () => {
    const { state, api, onPaid } = await atPayStep();
    const id = state().attempt!.id;
    api.attempt.mockResolvedValue(attempt("superseded", "paid", id));
    await vi.advanceTimersByTimeAsync(3000);
    expect(state().step).toBe("paid");
    expect(onPaid).not.toHaveBeenCalled();
  });

  it("gives up with an explanation when the invoice expires before any money arrives", async () => {
    const { state, api } = await atPayStep();
    const id = state().attempt!.id;
    api.attempt.mockResolvedValue(attempt("awaiting", "expired", id));
    await vi.advanceTimersByTimeAsync(3000);
    expect(state().step).toBe("unavailable");
    expect(state().unavailable?.kind).toBe("expired");
  });

  it("keeps waiting on a payment that is already confirming even if the invoice clock ran out", async () => {
    const { state, api } = await atPayStep();
    const id = state().attempt!.id;
    api.attempt.mockResolvedValue(attempt("confirming", "expired", id));
    await vi.advanceTimersByTimeAsync(3000);
    expect(state().step).toBe("pay");
  });
});

describe("changing token", () => {
  it("goes back to the picker, stops watching the old address, and a new attempt is watched instead", async () => {
    const { controller, state, api } = await atPayStep();
    const first = state().attempt!.id;

    controller.changeToken();
    expect(state()).toMatchObject({ step: "token", network: { chain: "base" }, attempt: null });

    api.attempt.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.attempt).not.toHaveBeenCalled();

    api.createAttempt.mockResolvedValueOnce(attempt("awaiting", "open", "att_second"));
    controller.pickToken(USDC_BASE);
    await controller.submitAddress();
    expect(state().attempt!.id).toBe("att_second");
    expect(state().attempt!.id).not.toBe(first);

    api.attempt.mockResolvedValue(attempt("awaiting", "open", "att_second"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.attempt).toHaveBeenCalledWith("att_second");
  });

  it("ignores a status answer that arrives after the payer has already moved on", async () => {
    const { controller, state, api } = await atPayStep();
    const id = state().attempt!.id;
    let answer!: (a: PublicAttempt) => void;
    api.attempt.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));

    await vi.advanceTimersByTimeAsync(3000); // the poll is now in flight
    controller.changeToken();
    answer(attempt("confirming", "open", id)); // the old attempt answers late
    await vi.advanceTimersByTimeAsync(0);

    expect(state()).toMatchObject({ step: "token", attempt: null });
    api.attempt.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.attempt).not.toHaveBeenCalled();
  });

  it("is refused while a deposit is confirming, because money is already on its way", async () => {
    const { controller, state, api } = await atPayStep();
    const id = state().attempt!.id;
    api.attempt.mockResolvedValue(attempt("confirming", "open", id));
    await vi.advanceTimersByTimeAsync(3000);

    controller.changeToken();

    expect(state().step).toBe("pay");
    expect(state().attempt?.status).toBe("confirming");
  });
});

describe("destroy and subscribe", () => {
  it("stops polling when destroyed", async () => {
    const { controller, api } = await atPayStep();
    controller.destroy();
    api.attempt.mockClear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.attempt).not.toHaveBeenCalled();
  });

  it("does not start watching an attempt that finished creating after the widget was closed", async () => {
    let finish!: (a: PublicAttempt) => void;
    const s = setup({ createAttempt: () => new Promise((resolve) => (finish = resolve)) });
    await s.controller.loaded;
    choose(s.controller, USDC_BASE);
    s.controller.setRefundTo(EVM);
    const pending = s.controller.submitAddress();

    s.controller.destroy();
    finish(attempt());
    await pending;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(s.api.attempt).not.toHaveBeenCalled();
  });

  it("tells subscribers about every change until they unsubscribe", async () => {
    const { controller } = setup();
    const seen: string[] = [];
    const unsubscribe = controller.subscribe((s) => seen.push(s.step));

    await controller.loaded;
    controller.start();
    unsubscribe();
    controller.back();

    expect(seen).toEqual(["summary", "network"]);
  });
});
