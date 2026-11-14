// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { login, setUnauthorizedHandler } from "../dashboard/src/api.js";
import { InvoiceDetail } from "../dashboard/src/components/InvoiceDetail.js";
import { RefundDialog } from "../dashboard/src/components/RefundDialog.js";
import { attempt, invoice, mockApi, preview, prepared, refund } from "./helpers/dashboardApi.js";
import { renderWithWallet, stubWallet } from "./helpers/dashboardWallet.js";

const ID = "inv_01M6XB4JSTR4YT9EJEZWP0QHMQ";
const REFUNDS = `/v1/invoices/${ID}/refunds`;

afterEach(() => {
  cleanup();
  setUnauthorizedHandler(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function signedIn(routes: Parameters<typeof mockApi>[0]) {
  const api = mockApi({ "POST /dashboard/api/login": { body: { csrfToken: "csrf" } }, ...routes });
  await login("s");
  return api;
}

const amountBox = () => screen.getByLabelText(/Amount to refund/) as HTMLInputElement;
/** The main button of the dialog: Approve in wallet, Connect wallet to approve, or what it says while working. */
const mainButton = () =>
  screen.getByRole("button", {
    name: /^(Approve in wallet|Connect wallet to approve|Creating the refund|Preparing the refund|Waiting for your wallet|Sending the refund)/,
  }) as HTMLButtonElement;
const approveReady = async () =>
  waitFor(() => {
    expect(screen.getByRole("button", { name: "Approve in wallet" })).toBeTruthy();
    expect(mainButton().disabled).toBe(false);
  });

/** The routes of a refund that goes through, with the status the refund has at each point. */
function refundRoutes(state: { status: string; txLinks?: unknown[] } = { status: "submitted" }) {
  return {
    [`POST /v1/invoices/${ID}/refunds/preview`]: { body: preview() },
    [`POST ${REFUNDS}`]: {
      status: 201,
      body: { replayed: false, refund: refund({ status: "awaiting_approval", amount: "12.5", intentHash: null }) },
    },
    "POST /v1/refunds/ref_1/prepare": { body: prepared() },
    "POST /v1/refunds/ref_1/submit": {
      body: { refund: refund({ status: "submitted", amount: "12.5" }), invoice: invoice() },
    },
    [`GET /v1/invoices/${ID}`]: () => ({
      body: {
        invoice: invoice(),
        attempts: [attempt()],
        refunds: [refund({ amount: "12.5", status: state.status, txLinks: state.txLinks ?? [] })],
      },
    }),
  };
}

function renderDialog(
  stub = stubWallet(),
  options: Parameters<typeof renderWithWallet>[2] = {},
  props: Partial<Parameters<typeof RefundDialog>[0]> = {},
) {
  const onChanged = vi.fn<() => void>();
  const onClose = vi.fn<() => void>();
  renderWithWallet(
    <RefundDialog open invoiceId={ID} onClose={onClose} onChanged={onChanged} pollMs={20} {...props} />,
    stub,
    options,
  );
  return { onChanged, onClose, stub };
}

const dialogAt = (open: boolean) => (
  <RefundDialog open={open} invoiceId={ID} onClose={() => undefined} onChanged={() => undefined} pollMs={20} />
);

describe("the refund dialog", () => {
  it("starts by asking what refunding everything would do, fills the amount, and shows who gets what where", async () => {
    const api = await signedIn({ [`POST /v1/invoices/${ID}/refunds/preview`]: { body: preview() } });
    renderDialog();

    await waitFor(() => expect(amountBox().value).toBe("12.5"));
    expect(await screen.findByText(/12.49 USDC/)).toBeTruthy();
    expect(screen.getByText(/on Base/)).toBeTruthy();
    expect(screen.getByText(/today's price/)).toBeTruthy();
    expect(api.to("POST", `/v1/invoices/${ID}/refunds/preview`)[0]!.body).toEqual({});
    await approveReady();
    // the quote on screen is the one the amount was filled from: nothing is asked twice
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(api.to("POST", `/v1/invoices/${ID}/refunds/preview`)).toHaveLength(1);
  });

  it("quotes again for an amount that is typed, and will not approve until that quote is in", async () => {
    let answer = preview();
    const api = await signedIn({ [`POST /v1/invoices/${ID}/refunds/preview`]: () => ({ body: answer }) });
    renderDialog();
    await approveReady();

    answer = preview({
      amount: "5",
      amountBase: "5000000",
      estimate: { ...preview().estimate, amountOutFormatted: "4.99" },
    });
    fireEvent.change(amountBox(), { target: { value: "5" } });
    expect(mainButton().disabled).toBe(true);

    await waitFor(() => expect(screen.getByText(/4.99 USDC/)).toBeTruthy());
    expect(mainButton().disabled).toBe(false);
    expect(api.to("POST", `/v1/invoices/${ID}/refunds/preview`).at(-1)!.body).toEqual({ amount: "5" });
  });

  it("shows why a quote could not be made, and offers no way to approve", async () => {
    await signedIn({
      [`POST /v1/invoices/${ID}/refunds/preview`]: {
        status: 409,
        body: { error: { code: "insufficient_balance", message: "The settlement balance cannot cover this." } },
      },
    });
    renderDialog();
    expect((await screen.findByRole("alert")).textContent).toContain("settlement balance cannot cover");
    expect(mainButton().disabled).toBe(true);
  });

  describe("approving with the wallet", () => {
    it("asks for the refund, has the server prepare it, has the wallet sign exactly that, and sends the signature back", async () => {
      const api = await signedIn(refundRoutes());
      const { onChanged, stub } = renderDialog();
      await approveReady();

      fireEvent.click(mainButton());

      expect(await screen.findByText("Processing")).toBeTruthy();
      const asked = api.to("POST", REFUNDS);
      expect(asked).toHaveLength(1);
      expect(asked[0]!.body).toEqual({ amount: "12.5", idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      expect(asked[0]!.headers["x-csrf-token"]).toBe("csrf");

      expect(api.to("POST", "/v1/refunds/ref_1/prepare")).toHaveLength(1);
      // The wallet is asked to sign the message the server prepared, as the recipient it named, for the account that has to sign.
      const signed = stub.wallet.signMessage.mock.calls[0]![0];
      expect(signed).toMatchObject({
        message: prepared().payload.message,
        recipient: "intents.near",
        signerId: "demo-shop.near",
        network: "mainnet",
      });
      expect(signed.nonce).toBeInstanceOf(Uint8Array);
      expect(Array.from(signed.nonce)).toEqual(Array.from({ length: 32 }, () => 1));
      // Only the key and the signature go back: the server uses the payload it kept.
      const submit = api.to("POST", "/v1/refunds/ref_1/submit");
      expect(submit).toHaveLength(1);
      expect(submit[0]!.body).toEqual({ publicKey: "ed25519:WALLETKEY", signature: "WALLETSIGNATURE" });
      expect(onChanged).toHaveBeenCalled();
    });

    it("then follows the refund to the end, tells the merchant, and asks the page to reload", async () => {
      const state = { status: "submitted", txLinks: [] as unknown[] };
      await signedIn(refundRoutes(state));
      const { onChanged } = renderDialog();
      await approveReady();
      fireEvent.click(mainButton());
      expect(await screen.findByText("Processing")).toBeTruthy();

      state.status = "succeeded";
      state.txLinks = [{ hash: "0xout", explorerUrl: "https://basescan.org/tx/0xout" }];

      expect(await screen.findByText("Refunded")).toBeTruthy();
      expect(screen.getByRole("link", { name: /0xout/ })).toBeTruthy();
      expect(screen.getByText("Refund completed")).toBeTruthy(); // the toast
      expect(onChanged).toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    });

    it("reports a refund that failed, with the reason", async () => {
      const routes = refundRoutes();
      routes[`GET /v1/invoices/${ID}`] = () => ({
        body: {
          invoice: invoice(),
          attempts: [attempt()],
          refunds: [refund({ status: "failed", error: "NEAR Intents reported FAILED." })],
        },
      });
      await signedIn(routes);
      renderDialog();
      await approveReady();
      fireEvent.click(mainButton());
      expect(await screen.findByText("Refund failed")).toBeTruthy();
      expect(screen.getAllByText(/reported FAILED/).length).toBeGreaterThan(0);
    });

    it("cannot be approved twice at once", async () => {
      let release: (() => void) | undefined;
      const routes = refundRoutes();
      routes[`POST ${REFUNDS}`] = (() =>
        new Promise(
          (resolve) =>
            (release = () => resolve({ status: 201, body: { refund: refund({ status: "awaiting_approval" }) } })),
        )) as never;
      const api = await signedIn(routes);
      renderDialog();
      await approveReady();

      fireEvent.click(mainButton());
      await waitFor(() => expect(mainButton().disabled).toBe(true));
      fireEvent.click(mainButton());
      await act(async () => release?.());

      expect(api.to("POST", REFUNDS)).toHaveLength(1);
    });
  });

  describe("when the wallet is not ready", () => {
    it("offers Connect wallet instead of Approve, connects, and then offers Approve", async () => {
      await signedIn(refundRoutes());
      const { stub } = renderDialog(stubWallet(), { connected: false });
      await screen.findByText(/Connect your wallet to approve this refund/);

      fireEvent.click(screen.getByRole("button", { name: "Connect wallet to approve" }));

      await waitFor(() => expect(stub.connector.connect).toHaveBeenCalledTimes(1));
      await approveReady();
      expect(stub.wallet.signMessage).not.toHaveBeenCalled(); // connecting is not approving
    });

    it("refuses a wallet that is signed in as another account, and says which one to use", async () => {
      const api = await signedIn(refundRoutes());
      renderDialog(stubWallet({ account: "someone-else.near" }));
      expect(await screen.findByText(/You're connected as someone-else.near/)).toBeTruthy();
      expect(screen.getByText(/approved by demo-shop.near/)).toBeTruthy();
      await waitFor(() => expect(mainButton().disabled).toBe(true));
      expect(api.to("POST", REFUNDS)).toHaveLength(0);
    });

    it("keeps the refund waiting when the wallet will not sign, and approves the same refund again without asking twice", async () => {
      const stub = stubWallet({ signFails: "User rejected the request." });
      const api = await signedIn(refundRoutes());
      renderDialog(stub);
      await approveReady();

      fireEvent.click(mainButton());

      expect((await screen.findByRole("alert")).textContent).toContain("Your wallet didn't approve the refund");
      expect(screen.getByRole("alert").textContent).toContain("User rejected the request.");
      expect(screen.getByText(/waits for your approval/)).toBeTruthy();
      expect(api.to("POST", "/v1/refunds/ref_1/submit")).toHaveLength(0);

      stub.wallet.signMessage.mockImplementationOnce(async () => ({
        accountId: "demo-shop.near",
        publicKey: "ed25519:WALLETKEY",
        signature: "WALLETSIGNATURE",
      }));
      await approveReady();
      fireEvent.click(mainButton());
      expect(await screen.findByText("Processing")).toBeTruthy();
      // One refund was asked for, the server prepared it twice, and the wallet signed the second time.
      expect(api.to("POST", REFUNDS)).toHaveLength(1);
      expect(api.to("POST", "/v1/refunds/ref_1/prepare")).toHaveLength(2);
    });

    it("explains an unregistered key, and registers it with the wallet when asked", async () => {
      const stub = stubWallet();
      const routes = refundRoutes();
      routes["POST /v1/refunds/ref_1/submit"] = {
        status: 409,
        body: { error: { code: "key_not_registered", message: "The wallet's key is not registered." } },
      } as never;
      await signedIn(routes);
      renderDialog(stub);
      await approveReady();
      fireEvent.click(mainButton());

      expect((await screen.findByRole("alert")).textContent).toMatch(
        /doesn't recognize this wallet's key for demo-shop.near/,
      );
      fireEvent.click(screen.getByRole("button", { name: "Register key" }));

      await waitFor(() => expect(stub.wallet.signAndSendTransaction).toHaveBeenCalledTimes(1));
      expect(stub.wallet.signAndSendTransaction.mock.calls[0]![0]).toMatchObject({
        receiverId: "intents.near",
        signerId: "demo-shop.near",
        actions: [
          {
            type: "FunctionCall",
            params: { methodName: "add_public_key", args: { public_key: "ed25519:WALLETKEY" }, deposit: "1" },
          },
        ],
      });
      expect(await screen.findByText("Key registered")).toBeTruthy();
    });

    it("says to approve again when the prepared refund expired, and shows a key type NEAR Intents cannot use", async () => {
      const routes = refundRoutes();
      routes["POST /v1/refunds/ref_1/submit"] = {
        status: 409,
        body: { error: { code: "intent_expired", message: "The deadline has already passed" } },
      } as never;
      const api = await signedIn(routes);
      renderDialog();
      await approveReady();
      fireEvent.click(mainButton());
      expect((await screen.findByRole("alert")).textContent).toMatch(
        /expired because it took too long. Approve the refund again/,
      );

      api.set("POST /v1/refunds/ref_1/submit", {
        status: 422,
        body: {
          error: {
            code: "unsupported_key_type",
            message: "This wallet signed with a mldsa65 key. NEAR Intents accepts ed25519, secp256k1, p256 keys.",
          },
        },
      });
      await approveReady();
      fireEvent.click(mainButton());
      await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/mldsa65/));
      expect(screen.queryByRole("button", { name: "Register key" })).toBeNull(); // not a key that can be registered
    });
  });

  it("shows the server's refusal to ask for the refund, and lets the merchant try again with the same key", async () => {
    let refuse = true;
    const routes = refundRoutes();
    routes[`POST ${REFUNDS}`] = (() =>
      refuse
        ? {
            status: 422,
            body: { error: { code: "daily_refund_limit", message: "Refunds are limited to 200 USDC per day." } },
          }
        : { status: 201, body: { refund: refund({ status: "awaiting_approval" }) } }) as never;
    const api = await signedIn(routes);
    renderDialog();
    await approveReady();

    fireEvent.click(mainButton());
    expect((await screen.findByRole("alert")).textContent).toContain("limited to 200 USDC per day");

    refuse = false;
    fireEvent.click(mainButton());
    expect(await screen.findByText("Processing")).toBeTruthy();
    const keys = api.to("POST", REFUNDS).map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("gives a reopened dialog a fresh key and a fresh quote", async () => {
    const state = { status: "succeeded" };
    const api = await signedIn(refundRoutes(state));
    const stub = stubWallet();
    const view = renderWithWallet(dialogAt(true), stub);
    await approveReady();
    fireEvent.click(mainButton());
    await screen.findByText("Refunded");

    view.unmount();
    const again = renderWithWallet(dialogAt(true), stub);
    await approveReady();
    fireEvent.click(mainButton());
    await waitFor(() => expect(api.to("POST", REFUNDS)).toHaveLength(2));
    const [a, b] = api.to("POST", REFUNDS).map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(a).not.toBe(b);
    again.unmount();
  });
});

describe("an invoice page with the refund dialog open over it", () => {
  it("keeps showing the refund's progress after the page behind it reloads", async () => {
    const state = { status: "submitted" };
    const routes = refundRoutes(state);
    let created = false;
    routes[`GET /v1/invoices/${ID}`] = () => ({
      body: {
        invoice: invoice(),
        attempts: [attempt()],
        refunds: created ? [refund({ amount: "12.5", status: "submitted" })] : [],
      },
    });
    routes["POST /v1/refunds/ref_1/submit"] = (() => {
      created = true;
      return { body: { refund: refund({ status: "submitted", amount: "12.5" }), invoice: invoice() } };
    }) as never;
    const api = await signedIn(routes);
    renderWithWallet(<InvoiceDetail id={ID} />, stubWallet());

    fireEvent.click(await screen.findByRole("button", { name: "Refund" }));
    await approveReady();
    fireEvent.click(mainButton());

    await waitFor(() => expect(screen.getAllByText("Processing").length).toBeGreaterThan(0));
    // the page behind it reloaded after the refund was created...
    await waitFor(() => expect(api.to("GET", `/v1/invoices/${ID}`).length).toBeGreaterThan(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100)); // let the reload finish rendering
    });
    // ...and the dialog is still on the refund, not back at an empty form
    expect(screen.queryByLabelText(/Amount to refund/)).toBeNull();
    expect(screen.getByText(/You can close this window/)).toBeTruthy();
    expect(api.to("POST", REFUNDS)).toHaveLength(1);
  });

  it("offers Refund only for a paid invoice that still has something to refund", async () => {
    await signedIn({
      [`GET /v1/invoices/${ID}`]: {
        body: { invoice: invoice({ status: "open", paidAttemptId: null }), attempts: [], refunds: [] },
      },
    });
    const view = renderWithWallet(<InvoiceDetail id={ID} />, stubWallet());
    await screen.findByText("Open");
    expect(screen.queryByRole("button", { name: "Refund" })).toBeNull();
    view.unmount();

    await signedIn({
      [`GET /v1/invoices/${ID}`]: {
        body: {
          invoice: invoice({ refundedAmountBase: "12500000", refundedAmount: "12.5" }),
          attempts: [],
          refunds: [refund({ status: "succeeded", amountBase: "12500000" })],
        },
      },
    });
    renderWithWallet(<InvoiceDetail id={ID} />, stubWallet());
    await screen.findAllByText("Refunded");
    expect(screen.queryByRole("button", { name: "Refund" })).toBeNull();
  });

  it("does not offer Refund while earlier refunds, including ones waiting for approval, already cover the invoice", async () => {
    for (const status of ["submitted", "awaiting_approval"]) {
      cleanup();
      await signedIn({
        [`GET /v1/invoices/${ID}`]: {
          body: { invoice: invoice(), attempts: [], refunds: [refund({ amountBase: "12500000", status })] },
        },
      });
      renderWithWallet(<InvoiceDetail id={ID} />, stubWallet());
      await screen.findByText(status === "submitted" ? "Processing" : "Waiting for approval");
      expect(screen.queryByRole("button", { name: "Refund" })).toBeNull();
    }
  });

  it("shows whether the quote's signature on each payment verified, and what a failure means", async () => {
    await signedIn({
      [`GET /v1/invoices/${ID}`]: {
        body: {
          invoice: invoice(),
          attempts: [
            attempt({ id: "att_ok" }),
            attempt({ id: "att_bad", raw: { quote: {}, status: null, quoteVerified: false } }),
          ],
          refunds: [],
        },
      },
    });
    renderWithWallet(<InvoiceDetail id={ID} />, stubWallet());

    expect(await screen.findByText("Verified")).toBeTruthy();
    expect(screen.getByText("Not verified")).toBeTruthy();
    expect(screen.getByText(/couldn't verify this payment's signature/)).toBeTruthy();
  });

  it("lets the merchant approve or cancel a refund that is waiting, from the invoice, without opening the dialog", async () => {
    const waiting = refund({ status: "awaiting_approval", reason: "overpayment_auto", amount: "5" });
    const stub = stubWallet();
    const api = await signedIn({
      [`GET /v1/invoices/${ID}`]: { body: { invoice: invoice(), attempts: [attempt()], refunds: [waiting] } },
      "POST /v1/refunds/ref_1/prepare": { body: prepared() },
      "POST /v1/refunds/ref_1/submit": { body: { refund: refund({ status: "submitted" }), invoice: invoice() } },
      "POST /v1/refunds/ref_1/cancel": { body: { refund: refund({ status: "failed", error: "Canceled." }) } },
    });
    renderWithWallet(<InvoiceDetail id={ID} />, stub);

    expect(await screen.findByText("Extra payment")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Approve refund ref_1" }));
    await waitFor(() => expect(api.to("POST", "/v1/refunds/ref_1/submit")).toHaveLength(1));
    expect(stub.wallet.signMessage).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Refund approved")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel refund ref_1" }));
    await waitFor(() => expect(api.to("POST", "/v1/refunds/ref_1/cancel")).toHaveLength(1));
    expect(await screen.findByText("Refund canceled")).toBeTruthy();
  });
});
