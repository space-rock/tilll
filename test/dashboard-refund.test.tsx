// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { login, setUnauthorizedHandler } from "../dashboard/src/api.js";
import { InvoiceDetail } from "../dashboard/src/components/InvoiceDetail.js";
import { RefundDialog } from "../dashboard/src/components/RefundDialog.js";
import { ToastProvider } from "../dashboard/src/components/ui/toast.js";
import { attempt, invoice, mockApi, preview, refund } from "./helpers/dashboardApi.js";

const ID = "inv_01M6XB4JSTR4YT9EJEZWP0QHMQ";

afterEach(() => {
  cleanup();
  setUnauthorizedHandler(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function signedIn(routes: Parameters<typeof mockApi>[0]) {
  const api = mockApi({ "POST /dashboard/api/login": { body: { csrfToken: "csrf" } }, ...routes });
  await login("s");
  return api;
}

const amountBox = () => screen.getByLabelText(/Amount to refund/) as HTMLInputElement;
const confirmButton = () => screen.getByRole("button", { name: /Confirm refund|Sending/ }) as HTMLButtonElement;

function renderDialog(props: Partial<Parameters<typeof RefundDialog>[0]> = {}) {
  const onChanged = vi.fn<() => void>();
  const onClose = vi.fn<() => void>();
  render(
    <ToastProvider>
      <RefundDialog open invoiceId={ID} onClose={onClose} onChanged={onChanged} pollMs={20} {...props} />
    </ToastProvider>,
  );
  return { onChanged, onClose };
}

describe("the refund dialog", () => {
  it("starts by asking what refunding everything would do, fills the amount, and shows who gets what where", async () => {
    const api = await signedIn({ [`POST /v1/invoices/${ID}/refunds/preview`]: { body: preview() } });
    renderDialog();

    await waitFor(() => expect(amountBox().value).toBe("12.5"));
    expect(await screen.findByText(/12.49 USDC/)).toBeTruthy();
    expect(screen.getByText(/on base/)).toBeTruthy();
    expect(screen.getByText(/today's price/)).toBeTruthy();
    expect(api.to("POST", `/v1/invoices/${ID}/refunds/preview`)[0]!.body).toEqual({});
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    // the quote on screen is the one the amount was filled from: nothing is asked twice
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(api.to("POST", `/v1/invoices/${ID}/refunds/preview`)).toHaveLength(1);
  });

  it("quotes again for an amount that is typed, and will not confirm until that quote is in", async () => {
    let answer = preview();
    const api = await signedIn({ [`POST /v1/invoices/${ID}/refunds/preview`]: () => ({ body: answer }) });
    renderDialog();
    await waitFor(() => expect(confirmButton().disabled).toBe(false));

    answer = preview({
      amount: "5",
      amountBase: "5000000",
      estimate: { ...preview().estimate, amountOutFormatted: "4.99" },
    });
    fireEvent.change(amountBox(), { target: { value: "5" } });
    expect(confirmButton().disabled).toBe(true);

    await waitFor(() => expect(screen.getByText(/4.99 USDC/)).toBeTruthy());
    expect(confirmButton().disabled).toBe(false);
    expect(api.to("POST", `/v1/invoices/${ID}/refunds/preview`).at(-1)!.body).toEqual({ amount: "5" });
  });

  it("shows why a quote could not be made, and offers no way to confirm", async () => {
    await signedIn({
      [`POST /v1/invoices/${ID}/refunds/preview`]: {
        status: 409,
        body: { error: { code: "insufficient_balance", message: "The settlement balance cannot cover this." } },
      },
    });
    renderDialog();
    expect((await screen.findByRole("alert")).textContent).toContain("settlement balance cannot cover");
    expect(confirmButton().disabled).toBe(true);
  });

  it("sends the refund with an idempotency key, then follows it to the end, tells the merchant and asks the page to reload", async () => {
    let status = "submitted";
    const api = await signedIn({
      [`POST /v1/invoices/${ID}/refunds/preview`]: { body: preview() },
      [`POST /v1/invoices/${ID}/refunds`]: {
        status: 201,
        body: { replayed: false, refund: refund({ amount: "12.5", status: "submitted" }) },
      },
      [`GET /v1/invoices/${ID}`]: () => ({
        body: {
          invoice: invoice(),
          attempts: [attempt()],
          refunds: [
            refund({
              amount: "12.5",
              status,
              txLinks: status === "succeeded" ? [{ hash: "0xout", explorerUrl: "https://basescan.org/tx/0xout" }] : [],
            }),
          ],
        },
      }),
    });
    const { onChanged } = renderDialog();
    await waitFor(() => expect(confirmButton().disabled).toBe(false));

    fireEvent.click(confirmButton());

    expect(await screen.findByText("In progress")).toBeTruthy();
    const sent = api.to("POST", `/v1/invoices/${ID}/refunds`);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ amount: "12.5", idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(sent[0]!.headers["x-csrf-token"]).toBe("csrf");

    status = "succeeded";
    expect(await screen.findByText("Refunded")).toBeTruthy();
    expect(screen.getByRole("link", { name: /0xout/ })).toBeTruthy();
    expect(screen.getByText("Refund sent")).toBeTruthy(); // the toast
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("reports a refund that failed, with the reason", async () => {
    await signedIn({
      [`POST /v1/invoices/${ID}/refunds/preview`]: { body: preview() },
      [`POST /v1/invoices/${ID}/refunds`]: { status: 201, body: { refund: refund({ status: "submitted" }) } },
      [`GET /v1/invoices/${ID}`]: {
        body: {
          invoice: invoice(),
          attempts: [attempt()],
          refunds: [refund({ status: "failed", error: "1Click reported FAILED." })],
        },
      },
    });
    renderDialog();
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    fireEvent.click(confirmButton());
    expect(await screen.findByText("Refund failed")).toBeTruthy();
    expect(screen.getAllByText(/1Click reported FAILED/).length).toBeGreaterThan(0);
  });

  it("shows the server's refusal and lets the merchant try again with the same key", async () => {
    let refuse = true;
    const api = await signedIn({
      [`POST /v1/invoices/${ID}/refunds/preview`]: { body: preview() },
      [`POST /v1/invoices/${ID}/refunds`]: () =>
        refuse
          ? {
              status: 422,
              body: { error: { code: "daily_refund_limit", message: "Refunds are limited to 200 USDC per day." } },
            }
          : { status: 201, body: { refund: refund() } },
      [`GET /v1/invoices/${ID}`]: { body: { invoice: invoice(), attempts: [], refunds: [refund()] } },
    });
    renderDialog();
    await waitFor(() => expect(confirmButton().disabled).toBe(false));

    fireEvent.click(confirmButton());
    expect((await screen.findByRole("alert")).textContent).toContain("limited to 200 USDC per day");

    refuse = false;
    fireEvent.click(confirmButton());
    expect(await screen.findByText("In progress")).toBeTruthy();
    const keys = api
      .to("POST", `/v1/invoices/${ID}/refunds`)
      .map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("cannot be confirmed twice at once", async () => {
    let release: (() => void) | undefined;
    const api = await signedIn({
      [`POST /v1/invoices/${ID}/refunds/preview`]: { body: preview() },
      [`POST /v1/invoices/${ID}/refunds`]: () =>
        new Promise((resolve) => (release = () => resolve({ status: 201, body: { refund: refund() } }))),
      [`GET /v1/invoices/${ID}`]: { body: { invoice: invoice(), attempts: [], refunds: [refund()] } },
    });
    renderDialog();
    await waitFor(() => expect(confirmButton().disabled).toBe(false));

    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirmButton().disabled).toBe(true));
    fireEvent.click(confirmButton());
    await act(async () => release?.());

    expect(api.to("POST", `/v1/invoices/${ID}/refunds`)).toHaveLength(1);
  });

  it("gives a reopened dialog a fresh key and a fresh quote", async () => {
    const api = await signedIn({
      [`POST /v1/invoices/${ID}/refunds/preview`]: { body: preview() },
      [`POST /v1/invoices/${ID}/refunds`]: { status: 201, body: { refund: refund() } },
      [`GET /v1/invoices/${ID}`]: {
        body: { invoice: invoice(), attempts: [], refunds: [refund({ status: "succeeded" })] },
      },
    });
    const view = render(
      <ToastProvider>
        <RefundDialog open invoiceId={ID} onClose={() => undefined} onChanged={() => undefined} pollMs={20} />
      </ToastProvider>,
    );
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    fireEvent.click(confirmButton());
    await screen.findByText("Refunded");

    const again = (open: boolean) => (
      <ToastProvider>
        <RefundDialog open={open} invoiceId={ID} onClose={() => undefined} onChanged={() => undefined} pollMs={20} />
      </ToastProvider>
    );
    view.rerender(again(false));
    view.rerender(again(true));
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(api.to("POST", `/v1/invoices/${ID}/refunds`)).toHaveLength(2));
    const [a, b] = api
      .to("POST", `/v1/invoices/${ID}/refunds`)
      .map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(a).not.toBe(b);
  });
});

const routes = (state: { refunds: ReturnType<typeof refund>[] }) => ({
  [`GET /v1/invoices/${ID}`]: () => ({ body: { invoice: invoice(), attempts: [attempt()], refunds: state.refunds } }),
  [`POST /v1/invoices/${ID}/refunds/preview`]: { body: preview() },
  [`POST /v1/invoices/${ID}/refunds`]: () => {
    state.refunds = [refund({ amount: "12.5", status: "submitted" })];
    return { status: 201, body: { refund: state.refunds[0] } };
  },
});

describe("an invoice page with the refund dialog open over it", () => {
  it("keeps showing the refund's progress after the page behind it reloads", async () => {
    const api = await signedIn(routes({ refunds: [] }));
    render(
      <ToastProvider>
        <InvoiceDetail id={ID} />
      </ToastProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Refund" }));
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getAllByText("In progress").length).toBeGreaterThan(0));
    // the page behind it reloaded after the refund was created...
    await waitFor(() => expect(api.to("GET", `/v1/invoices/${ID}`).length).toBeGreaterThan(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100)); // let the reload finish rendering
    });
    // ...and the dialog is still on the refund, not back at an empty form
    expect(screen.queryByLabelText(/Amount to refund/)).toBeNull();
    expect(screen.getByText(/You can close this window/)).toBeTruthy();
    expect(api.to("POST", `/v1/invoices/${ID}/refunds`)).toHaveLength(1);
  });

  it("offers Refund only for a paid invoice that still has something to refund", async () => {
    await signedIn({
      [`GET /v1/invoices/${ID}`]: {
        body: { invoice: invoice({ status: "open", paidAttemptId: null }), attempts: [], refunds: [] },
      },
    });
    const view = render(
      <ToastProvider>
        <InvoiceDetail id={ID} />
      </ToastProvider>,
    );
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
    render(
      <ToastProvider>
        <InvoiceDetail id={ID} />
      </ToastProvider>,
    );
    await screen.findAllByText("Refunded");
    expect(screen.queryByRole("button", { name: "Refund" })).toBeNull();
  });

  it("does not offer Refund while earlier refunds already cover the invoice", async () => {
    await signedIn({
      [`GET /v1/invoices/${ID}`]: {
        body: { invoice: invoice(), attempts: [], refunds: [refund({ amountBase: "12500000", status: "submitted" })] },
      },
    });
    render(
      <ToastProvider>
        <InvoiceDetail id={ID} />
      </ToastProvider>,
    );
    await screen.findByText("In progress");
    expect(screen.queryByRole("button", { name: "Refund" })).toBeNull();
  });

  it("shows whether 1Click's signature on each payment's quote verified, and what a failure means", async () => {
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
    render(
      <ToastProvider>
        <InvoiceDetail id={ID} />
      </ToastProvider>,
    );

    expect(await screen.findByText("Verified")).toBeTruthy();
    expect(screen.getByText("Not verified")).toBeTruthy();
    expect(screen.getByText(/did not check out against 1Click's public key/)).toBeTruthy();
  });
});
