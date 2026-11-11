// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler } from "../dashboard/src/api.js";
import { App } from "../dashboard/src/App.js";
import { TxLinks } from "../dashboard/src/components/Bits.js";
import { attempt, invoice, mockApi, refund } from "./helpers/dashboardApi.js";

const overview = {
  asset: { id: "nep141:usdc", symbol: "USDC", decimals: 6 },
  account: "demo-shop.near",
  balance: { value: "250", valueBase: "250000000" },
  paidToday: { count: 2, amount: "17.5", amountBase: "17500000" },
  openInvoices: 3,
  refundedToday: { amount: "50", amountBase: "50000000" },
  limits: { maxPerTx: "50", maxPerTxBase: "50000000", maxPerDay: "200", maxPerDayBase: "200000000" },
  day: "2026-11-08",
};
const settings = {
  account: "demo-shop.near",
  asset: { id: "nep141:usdc", symbol: "USDC", decimals: 6 },
  intentsContract: "intents.near",
  publicBaseUrl: "http://localhost:8080",
  webhookUrl: "https://shop.example/hooks",
  oneclick: { baseUrl: "https://1click.example", apiKeySet: false, reachable: true },
  limits: { maxPerTx: "50", maxPerDay: "200" },
  attemptDeadlineMinutes: 30,
  slippageBps: 100,
};
const delivery = (over: Record<string, unknown> = {}) => ({
  id: "evt_1",
  type: "invoice.paid",
  createdAt: "2026-11-08T15:55:00.000Z",
  attempts: 1,
  nextTryAt: null,
  deliveredAt: "2026-11-08T15:55:01.000Z",
  lastError: null,
  state: "delivered",
  payload: { id: "evt_1", type: "invoice.paid" },
  ...over,
});

const loggedIn = {
  "GET /dashboard/api/session": { body: { csrfToken: "csrf" } },
  "GET /v1/settings": { body: settings },
  "GET /v1/overview": { body: overview },
  "GET /v1/invoices": { body: { invoices: [invoice()], nextCursor: null } },
  "GET /v1/webhooks": { body: { deliveries: [delivery()], nextCursor: null } },
  "GET /v1/refunds": { body: { refunds: [refund({ status: "succeeded" })], nextCursor: null } },
};

beforeEach(() => {
  window.history.pushState({}, "", "/dashboard");
});
afterEach(() => {
  cleanup();
  setUnauthorizedHandler(undefined);
  vi.unstubAllGlobals();
});

describe("logging in", () => {
  it("asks for the merchant secret when there is no session, and nothing else loads", async () => {
    const api = mockApi({
      "GET /dashboard/api/session": { status: 401, body: { error: { code: "unauthorized", message: "no" } } },
    });
    render(<App />);
    expect(await screen.findByLabelText("Merchant secret")).toBeTruthy();
    expect(api.calls.map((c) => c.path)).toEqual(["/dashboard/api/session"]);
  });

  it("shows the server's answer to a wrong secret and stays on the form", async () => {
    mockApi({
      "GET /dashboard/api/session": { status: 401, body: {} },
      "POST /dashboard/api/login": {
        status: 401,
        body: { error: { code: "unauthorized", message: "That is not the merchant secret." } },
      },
    });
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Merchant secret"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect((await screen.findByRole("alert")).textContent).toContain("not the merchant secret");
    expect(screen.getByLabelText("Merchant secret")).toBeTruthy();
  });

  it("says to wait when logins are rate limited", async () => {
    mockApi({
      "GET /dashboard/api/session": { status: 401, body: {} },
      "POST /dashboard/api/login": { status: 429, body: { error: { code: "rate_limited", message: "x" } } },
    });
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Merchant secret"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Wait a minute/);
  });

  it("opens the overview after a good login, and forgets the secret it was typed", async () => {
    mockApi({
      ...loggedIn,
      "GET /dashboard/api/session": { status: 401, body: {} },
      "POST /dashboard/api/login": { body: { csrfToken: "csrf" } },
    });
    render(<App />);
    const box = (await screen.findByLabelText("Merchant secret")) as HTMLInputElement;
    expect(box.type).toBe("password");
    fireEvent.change(box, { target: { value: "sk_test_secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByText("Settlement balance")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("sk_test_secret");
  });

  it("goes back to the login form when the server ends the session", async () => {
    const api = mockApi(loggedIn);
    render(<App />);
    await screen.findByText("Settlement balance");
    api.set("GET /v1/invoices", { status: 401, body: { error: { code: "unauthorized", message: "x" } } });
    fireEvent.click(screen.getByRole("link", { name: "Invoices" }));
    expect(await screen.findByLabelText("Merchant secret")).toBeTruthy();
  });

  it("logs out", async () => {
    const api = mockApi({ ...loggedIn, "POST /dashboard/api/logout": { status: 204 } });
    render(<App />);
    await screen.findByText("Settlement balance");
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByLabelText("Merchant secret")).toBeTruthy();
    expect(api.to("POST", "/dashboard/api/logout")).toHaveLength(1);
  });
});

describe("the overview", () => {
  it("shows the balance, today's payments, refunds against the daily limit and open invoices", async () => {
    mockApi(loggedIn);
    render(<App />);
    expect(await screen.findByText("250 USDC")).toBeTruthy();
    expect(screen.getByText("17.5 USDC")).toBeTruthy();
    expect(screen.getByText("50 USDC")).toBeTruthy();
    expect(screen.getByText(/of 200 USDC daily limit/)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("says so, with the reason, when the balance cannot be read", async () => {
    mockApi({
      ...loggedIn,
      "GET /v1/overview": {
        body: { ...overview, balance: null, balanceError: "Could not read the settlement balance: rpc down" },
      },
    });
    render(<App />);
    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.getByText(/rpc down/)).toBeTruthy();
  });

  it("tells a new merchant what to do first", async () => {
    mockApi({
      ...loggedIn,
      "GET /v1/invoices": { body: { invoices: [], nextCursor: null } },
      "GET /v1/webhooks": { body: { deliveries: [], nextCursor: null } },
    });
    render(<App />);
    expect(await screen.findByText(/Use "Create invoice"/)).toBeTruthy();
    expect(screen.getByText("Nothing sent yet")).toBeTruthy();
  });

  it("asks the server for the status that is picked in the filter", async () => {
    const api = mockApi(loggedIn);
    render(<App />);
    await screen.findByText("Recent invoices");
    fireEvent.click(screen.getByRole("button", { name: "Paid" }));
    await waitFor(() => expect(api.calls.some((c) => c.path.includes("status=paid"))).toBe(true));
  });

  it("shows an invoice's detail when it is chosen", async () => {
    mockApi({
      ...loggedIn,
      "GET /v1/invoices/inv_01M6XB4JSTR4YT9EJEZWP0QHMQ": {
        body: { invoice: invoice(), attempts: [attempt()], refunds: [] },
      },
    });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Open invoice inv_01M6/ }));
    expect(await screen.findByText("Payment attempts")).toBeTruthy();
    expect(screen.getByText("Customer's refund address")).toBeTruthy();
  });
});

describe("invoices, search and export", () => {
  it("searches from the top bar and asks the server for exactly that text", async () => {
    const api = mockApi(loggedIn);
    render(<App />);
    await screen.findByText("Settlement balance");

    fireEvent.change(screen.getByLabelText("Search invoices"), { target: { value: "a&b=c" } });
    fireEvent.submit(screen.getByRole("search"));

    expect(await screen.findByText(/Invoices matching "a&b=c"/)).toBeTruthy();
    await waitFor(() => expect(api.calls.some((c) => c.path.includes("q=a%26b%3Dc"))).toBe(true));
    expect(window.location.pathname + window.location.search).toBe("/dashboard/invoices?q=a%26b%3Dc");
  });

  it("loads the next page on request", async () => {
    const api = mockApi({
      ...loggedIn,
      "GET /v1/invoices": (call) =>
        call.path.includes("cursor=inv_A")
          ? { body: { invoices: [invoice({ id: "inv_B", description: "second page" })], nextCursor: null } }
          : { body: { invoices: [invoice({ id: "inv_A", description: "first page" })], nextCursor: "inv_A" } },
    });
    window.history.pushState({}, "", "/dashboard/invoices");
    render(<App />);
    await screen.findByText("first page");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("second page")).toBeTruthy();
    expect(screen.getByText("first page")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(api.to("GET", "/v1/invoices")).toHaveLength(2);
  });

  it("shows text from invoices as text, never as markup", async () => {
    mockApi({
      ...loggedIn,
      "GET /v1/invoices": {
        body: { invoices: [invoice({ description: '<img src=x onerror="alert(1)">' })], nextCursor: null },
      },
    });
    window.history.pushState({}, "", "/dashboard/invoices");
    render(<App />);
    expect(await screen.findByText('<img src=x onerror="alert(1)">')).toBeTruthy();
    expect(document.querySelector("img[onerror]")).toBeNull();
  });

  it("makes a test invoice from the top bar and shows its pay link", async () => {
    const api = mockApi({
      ...loggedIn,
      "POST /v1/invoices": {
        status: 201,
        body: { ...invoice({ status: "open", paidAttemptId: null }), payUrl: "http://localhost:8080/pay/inv_new" },
      },
    });
    render(<App />);
    await screen.findByText("Settlement balance");
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    fireEvent.change(await screen.findByLabelText(/Amount \(USDC\)/), { target: { value: "7.25" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Create invoice" }).at(-1)!);
    expect(await screen.findByText("http://localhost:8080/pay/inv_new")).toBeTruthy();
    expect(api.to("POST", "/v1/invoices")[0]!.body).toEqual({ amount: "7.25" });
    expect(api.to("POST", "/v1/invoices")[0]!.headers["x-csrf-token"]).toBe("csrf");
  });
});

describe("refunds, webhooks and settings", () => {
  it("lists refunds with a link to their invoice", async () => {
    mockApi(loggedIn);
    window.history.pushState({}, "", "/dashboard/refunds");
    render(<App />);
    const link = await screen.findByRole("link", { name: "inv_01M6XB4JSTR4YT9EJEZWP0QHMQ" });
    expect(link.getAttribute("href")).toBe("/dashboard/invoices/inv_01M6XB4JSTR4YT9EJEZWP0QHMQ");
  });

  it("resends a webhook and reports how the endpoint answered", async () => {
    const api = mockApi({
      ...loggedIn,
      "POST /v1/webhooks/evt_1/resend": {
        body: { id: "evt_1", delivered: false, status: 500, error: "HTTP 500", attempts: 2, gaveUp: false },
      },
    });
    window.history.pushState({}, "", "/dashboard/webhooks");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Resend evt_1" }));
    expect(await screen.findByText("Not delivered")).toBeTruthy();
    expect(screen.getByText("HTTP 500", { selector: "p" })).toBeTruthy();
    expect(api.to("POST", "/v1/webhooks/evt_1/resend")).toHaveLength(1);
  });

  it("shows how it is set up, and that an API key is not set, without showing a key", async () => {
    mockApi(loggedIn);
    window.history.pushState({}, "", "/dashboard/settings");
    render(<App />);
    expect(await screen.findByText(/API key not set/)).toBeTruthy();
    expect(screen.getByText("https://shop.example/hooks")).toBeTruthy();
    expect(screen.getByText(/50 USDC each, 200 USDC per day/)).toBeTruthy();
  });

  it("opens an invoice's page directly from its address", async () => {
    mockApi({
      ...loggedIn,
      "GET /v1/invoices/inv_x": { body: { invoice: invoice({ id: "inv_x" }), attempts: [], refunds: [] } },
    });
    window.history.pushState({}, "", "/dashboard/invoices/inv_x");
    render(<App />);
    expect(await screen.findByText("← All invoices")).toBeTruthy();
    expect(await screen.findByText("Timeline")).toBeTruthy();
  });

  it("says so for a page that does not exist", async () => {
    mockApi(loggedIn);
    window.history.pushState({}, "", "/dashboard/nowhere");
    render(<App />);
    expect(await screen.findByText("There is no such page.")).toBeTruthy();
  });
});

describe("transaction links", () => {
  it("links only http(s) explorers, never javascript: or data: URLs", () => {
    render(
      <TxLinks
        links={[
          { hash: "0xgood", explorerUrl: "https://basescan.org/tx/0xgood" },
          { hash: "0xevil", explorerUrl: "javascript:alert(1)" },
          { hash: "0xdata", explorerUrl: "data:text/html,<script>alert(1)</script>" },
        ]}
      />,
    );
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://basescan.org/tx/0xgood"]);
    expect(screen.getByRole("link").getAttribute("rel")).toContain("noopener");
  });
});
