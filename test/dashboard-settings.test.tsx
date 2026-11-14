// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvoiceDetail } from "../dashboard/src/components/InvoiceDetail.js";
import { ToastProvider } from "../dashboard/src/components/ui/toast.js";
import { SettingsPage } from "../dashboard/src/pages/Settings.js";
import type { SettingKey, Settings } from "../dashboard/src/types.js";
import { attempt, invoice, mockApi } from "./helpers/dashboardApi.js";
import { renderWithWallet, stubWallet } from "./helpers/dashboardWallet.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const KEYS: SettingKey[] = [
  "settlementAccount",
  "settlementAsset",
  "slippageBps",
  "attemptDeadlineMinutes",
  "webhookUrl",
  "publicBaseUrl",
  "refundMaxPerTx",
  "refundMaxPerDay",
];

function settingsWith(over: Partial<Settings> = {}): Settings {
  return {
    account: "demo-shop.near",
    asset: { id: "nep141:usdc", symbol: "USDC", decimals: 6 },
    intentsContract: "intents.near",
    network: "mainnet",
    publicBaseUrl: "http://localhost:8080",
    webhookUrl: "https://shop.example/hooks",
    oneclick: { baseUrl: "https://1click.example", apiKeySet: true, reachable: true },
    limits: { maxPerTx: "50", maxPerDay: "200" },
    attemptDeadlineMinutes: 30,
    slippageBps: 100,
    sources: Object.fromEntries(KEYS.map((key) => [key, { source: "env", updatedAt: null }])) as Settings["sources"],
    settlementLocked: null,
    history: [],
    ...over,
  };
}

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
/** The open dialog. The page behind it has buttons with the same names. */
const dialog = () => within(screen.getByRole("dialog"));
const clickIn = (name: string | RegExp) => fireEvent.click(dialog().getByRole("button", { name }));
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

function show(settings: Settings, reload = vi.fn<() => void>()) {
  render(
    <ToastProvider>
      <SettingsPage settings={settings} error={undefined} reload={reload} />
    </ToastProvider>,
  );
  return reload;
}

describe("editing a card on the settings page", () => {
  it("sends only what was changed, in the units the server wants, then loads the settings again", async () => {
    const api = mockApi({ "PATCH /v1/settings": { body: { changed: ["slippageBps"] } } });
    const reload = show(settingsWith());
    click("Edit payments");
    type("Slippage", "0.5");
    click("Save");

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(api.to("PATCH", "/v1/settings").map((c) => c.body)).toEqual([{ slippageBps: 50 }]);
    expect(await screen.findByText("Payments saved")).toBeTruthy();
  });

  it("sends every field that changed, with the payment window as a whole number", async () => {
    const api = mockApi({ "PATCH /v1/settings": { body: { changed: [] } } });
    show(settingsWith());
    click("Edit payments");
    type("Payment window", "45");
    type("Slippage", "2");
    click("Save");
    await waitFor(() => expect(api.to("PATCH", "/v1/settings")).toHaveLength(1));
    expect(api.to("PATCH", "/v1/settings")[0]!.body).toEqual({ attemptDeadlineMinutes: 45, slippageBps: 200 });
  });

  it("sends nothing when nothing changed, and nothing when canceled", () => {
    const api = mockApi({});
    show(settingsWith());
    click("Edit payments");
    click("Save");
    click("Edit refund limits");
    type("Limit per refund", "5");
    click("Cancel");
    expect(api.calls).toEqual([]);
    expect(screen.queryByLabelText("Limit per refund")).toBeNull();
  });

  it("says what is wrong with a typed value before asking the server, and keeps the form open", () => {
    const api = mockApi({});
    show(settingsWith());
    click("Edit payments");
    type("Slippage", "lots");
    click("Save");
    expect(screen.getByRole("alert").textContent).toMatch(/Slippage: enter a number/);
    type("Slippage", "1");
    type("Payment window", "1.5");
    click("Save");
    expect(screen.getByRole("alert").textContent).toMatch(/Payment window: enter a whole number/);
    expect(api.calls).toEqual([]);
    expect(screen.getByLabelText("Slippage")).toBeTruthy();
  });

  it("shows the server's reason next to the form when it refuses, and does not reload", async () => {
    mockApi({
      "PATCH /v1/settings": {
        status: 400,
        body: {
          error: {
            code: "invalid_setting",
            message: "Refund limit per refund: must be a positive decimal number, like 50",
          },
        },
      },
    });
    const reload = show(settingsWith());
    click("Edit refund limits");
    type("Limit per refund", "ten");
    click("Save");
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Refund limit per refund: must be a positive/);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Limit per refund")).toBeTruthy();
  });

  it("shows refund limits in the settlement asset, and sends the limits as typed", async () => {
    const api = mockApi({ "PATCH /v1/settings": { body: { changed: [] } } });
    show(settingsWith());
    expect(screen.getByText("Limit per refund").parentElement!.parentElement!.textContent).toContain("50 USDC");
    click("Edit refund limits");
    expect(screen.getAllByText("USDC").length).toBeGreaterThanOrEqual(2); // the unit beside each input
    type("Limit per day", "250.5");
    click("Save");
    await waitFor(() => expect(api.to("PATCH", "/v1/settings")).toHaveLength(1));
    expect(api.to("PATCH", "/v1/settings")[0]!.body).toEqual({ refundMaxPerDay: "250.5" });
  });
});

describe("where a setting comes from", () => {
  it("says From .env for a value nobody changed, and when and how a changed one can go back", async () => {
    const sources = settingsWith().sources;
    sources.slippageBps = { source: "dashboard", updatedAt: new Date(Date.now() - 3 * 60_000).toISOString() };
    const api = mockApi({ "DELETE /v1/settings/slippageBps": { body: { changed: ["slippageBps"] } } });
    const reload = show(settingsWith({ sources }));

    expect(screen.getAllByText("From .env").length).toBeGreaterThan(3);
    expect(screen.getByText(/Changed in dashboard · 3 minutes ago/)).toBeTruthy();
    click("Reset Slippage to its .env value");

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(api.to("DELETE", "/v1/settings/slippageBps")).toHaveLength(1);
    expect(await screen.findByText("Slippage reset")).toBeTruthy();
  });

  it("lists recent changes with what they were and what they became", () => {
    show(
      settingsWith({
        history: [
          { setting: "slippageBps", from: "100", to: "50", changedAt: new Date(Date.now() - 60_000).toISOString() },
          {
            setting: "webhookUrl",
            from: "https://a.example",
            to: "https://b.example",
            changedAt: "2026-11-01T10:00:00.000Z",
          },
        ],
      }),
    );
    const list = screen.getByText("Recent changes").closest("div")!.parentElement!;
    expect(within(list).getByText("Slippage")).toBeTruthy();
    expect(within(list).getByText("https://b.example")).toBeTruthy();
  });

  it("has no Recent changes card until something was changed", () => {
    show(settingsWith());
    expect(screen.queryByText("Recent changes")).toBeNull();
  });
});

describe("the public URL card", () => {
  it("saves a new address, and shows where the value comes from", async () => {
    const api = mockApi({ "PATCH /v1/settings": { body: { changed: ["publicBaseUrl"] } } });
    const reload = show(settingsWith());
    expect(screen.getByText("Public URL", { selector: "h2" })).toBeTruthy();
    click("Edit public url");
    type("Public URL", "https://pay.shop.example");
    click("Save");
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(api.to("PATCH", "/v1/settings").map((c) => c.body)).toEqual([{ publicBaseUrl: "https://pay.shop.example" }]);
  });

  it("is no longer listed among the settings that need a restart", () => {
    show(settingsWith());
    const connections = screen.getByText("Connections").closest("div")!.parentElement!;
    expect(within(connections).queryByText("Public URL")).toBeNull();
    expect(within(connections).getByText("NEAR Intents")).toBeTruthy();
  });
});

describe("the webhook card", () => {
  it("saves a new address", async () => {
    const api = mockApi({ "PATCH /v1/settings": { body: { changed: ["webhookUrl"] } } });
    show(settingsWith());
    click("Edit webhooks");
    type("Webhook URL", "https://shop.example/new");
    click("Save");
    await waitFor(() => expect(api.to("PATCH", "/v1/settings")).toHaveLength(1));
    expect(api.to("PATCH", "/v1/settings")[0]!.body).toEqual({ webhookUrl: "https://shop.example/new" });
  });

  it("sends a test event and says how the endpoint answered", async () => {
    const api = mockApi({
      "POST /v1/webhooks/test": {
        body: { eventId: "evt_1", delivered: true, status: 200, error: null, durationMs: 140 },
      },
    });
    show(settingsWith());
    click("Send test event");
    expect(await screen.findByText("Delivered · HTTP 200 in 140 ms")).toBeTruthy();
    expect(api.to("POST", "/v1/webhooks/test")).toHaveLength(1);
  });

  it("says why an endpoint did not take the event", async () => {
    mockApi({
      "POST /v1/webhooks/test": {
        body: { eventId: "evt_1", delivered: false, status: 500, error: "HTTP 500", durationMs: 80 },
      },
    });
    show(settingsWith());
    click("Send test event");
    expect(await screen.findByText(/Not delivered · HTTP 500 after 80 ms/)).toBeTruthy();
  });

  it("says so when the request itself fails", async () => {
    mockApi({
      "POST /v1/webhooks/test": {
        status: 502,
        body: { error: { code: "bad_gateway", message: "The server could not be reached" } },
      },
    });
    show(settingsWith());
    click("Send test event");
    expect(await screen.findByText(/Test failed: The server could not be reached/)).toBeTruthy();
  });
});

const NONCE = Buffer.alloc(32, 7).toString("base64");

function openAccountDialog(wallet: ReturnType<typeof stubWallet>, settings = settingsWith(), connected = true) {
  const reload = vi.fn<() => void>();
  renderWithWallet(<SettingsPage settings={settings} error={undefined} reload={reload} />, wallet, { connected });
  click("Change account");
  return reload;
}

function openAssetDialog(settings = settingsWith()) {
  const reload = vi.fn<() => void>();
  renderWithWallet(<SettingsPage settings={settings} error={undefined} reload={reload} />, stubWallet(), {
    connected: false,
  });
  click("Change asset");
  return reload;
}

const invoiceDetail = (over: Record<string, unknown>) => ({
  invoice: invoice({ id: "inv_old", settlementAccount: "old-shop.near" }),
  attempts: [attempt({ invoiceId: "inv_old" })],
  refunds: [],
  ...over,
});
const showInvoice = () =>
  render(
    <ToastProvider>
      <InvoiceDetail id="inv_old" />
    </ToastProvider>,
  );

describe("changing the settlement account", () => {
  const challenge = {
    message: "Use new-shop.near as the Tilll settlement account.",
    recipient: "tilll",
    nonce: NONCE,
    callbackUrl: null,
    expiresAt: "2026-11-12T10:00:00.000Z",
  };

  it("has the wallet sign a message for the new account, then saves it", async () => {
    const api = mockApi({
      "POST /v1/settings/account-challenge": { body: challenge },
      "PUT /v1/settings/account": { body: { changed: ["settlementAccount"] } },
    });
    const wallet = stubWallet({ account: "new-shop.near" });
    const reload = openAccountDialog(wallet);

    type("New account", "new-shop.near");
    fireEvent.click(await dialog().findByRole("button", { name: "Confirm in wallet" }));

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(api.to("POST", "/v1/settings/account-challenge")[0]!.body).toEqual({ accountId: "new-shop.near" });
    // It is the new account that signs, not the old settlement account.
    expect(wallet.wallet.signMessage).toHaveBeenCalledWith(
      expect.objectContaining({ signerId: "new-shop.near", recipient: "tilll", message: challenge.message }),
    );
    expect(api.to("PUT", "/v1/settings/account")[0]!.body).toEqual({
      accountId: "new-shop.near",
      nonce: NONCE,
      publicKey: "ed25519:WALLETKEY",
      signature: "WALLETSIGNATURE",
    });
    expect(await screen.findByText("Settlement account changed")).toBeTruthy();
  });

  it("asks to connect a wallet first, and goes on once it is signed in as the new account", async () => {
    mockApi({});
    const wallet = stubWallet({ account: "new-shop.near" });
    openAccountDialog(wallet, settingsWith(), false);
    type("New account", "new-shop.near");
    expect(dialog().queryByRole("button", { name: "Confirm in wallet" })).toBeNull();
    clickIn("Connect wallet");
    expect(await dialog().findByRole("button", { name: "Confirm in wallet" })).toBeTruthy();
    expect(wallet.connector.connect).toHaveBeenCalledTimes(1);
  });

  it("says which account the wallet is signed in as when it is another one, and offers to switch", async () => {
    mockApi({});
    const wallet = stubWallet({ account: "demo-shop.near" });
    openAccountDialog(wallet);
    type("New account", "new-shop.near");
    expect((await dialog().findByText(/Your wallet is signed in as/)).textContent).toContain("demo-shop.near");
    expect(dialog().getByRole("button", { name: "Switch wallet" })).toBeTruthy();
    expect(wallet.wallet.signMessage).not.toHaveBeenCalled();
  });

  it("shows the server's refusal and keeps the dialog open", async () => {
    mockApi({
      "POST /v1/settings/account-challenge": { body: challenge },
      "PUT /v1/settings/account": {
        status: 403,
        body: {
          error: { code: "key_not_full_access", message: "That key can only call certain contracts on new-shop.near." },
        },
      },
    });
    const reload = openAccountDialog(stubWallet({ account: "new-shop.near" }));
    type("New account", "new-shop.near");
    fireEvent.click(await dialog().findByRole("button", { name: "Confirm in wallet" }));
    expect((await dialog().findByRole("alert")).textContent).toMatch(/can only call certain contracts/);
    expect(reload).not.toHaveBeenCalled();
  });

  it("says when the wallet would not sign", async () => {
    mockApi({ "POST /v1/settings/account-challenge": { body: challenge } });
    openAccountDialog(stubWallet({ account: "new-shop.near", signFails: "User rejected" }));
    type("New account", "new-shop.near");
    fireEvent.click(await dialog().findByRole("button", { name: "Confirm in wallet" }));
    expect((await dialog().findByRole("alert")).textContent).toBe("Your wallet didn't sign: User rejected");
  });

  it("will not start while money is in motion, and says why", () => {
    mockApi({});
    openAccountDialog(
      stubWallet({ account: "new-shop.near" }),
      settingsWith({ settlementLocked: "Finish or cancel the 2 refunds still open first." }),
    );
    expect(dialog().getByText("Finish or cancel the 2 refunds still open first.")).toBeTruthy();
    expect((dialog().getByLabelText("New account") as HTMLInputElement).disabled).toBe(true);
    expect((dialog().getByRole("button", { name: "Confirm in wallet" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not offer the account that is already in use", () => {
    mockApi({});
    openAccountDialog(stubWallet({ account: "demo-shop.near" }));
    type("New account", "demo-shop.near");
    expect(dialog().getByText("That is already the settlement account.")).toBeTruthy();
    expect((dialog().getByRole("button", { name: "Confirm in wallet" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("changing the settlement asset", () => {
  const tokens = {
    chains: {
      near: [
        { assetId: "nep141:wrap.near", symbol: "wNEAR" },
        { assetId: "nep141:usdc", symbol: "USDC" },
      ],
      base: [{ assetId: "nep141:base-usdc", symbol: "USDC" }],
    },
  };

  it("finds an asset, asks for limits in its units, says what happens to old invoices, and saves", async () => {
    const api = mockApi({
      "GET /v1/tokens": { body: tokens },
      "PATCH /v1/settings": { body: { changed: ["settlementAsset"] } },
    });
    const reload = openAssetDialog();

    type("Find an asset", "wnear");
    fireEvent.click(await dialog().findByRole("button", { name: /wNEAR on NEAR/ }));

    // The limits start from the old numbers and are in the new asset.
    expect((screen.getByLabelText("Limit per refund") as HTMLInputElement).value).toBe("50");
    expect(screen.getAllByText("wNEAR").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Invoices you already made stay in USDC/)).toBeTruthy();
    expect(screen.getByText(/can.t refund those older invoices/)).toBeTruthy();

    type("Limit per refund", "1.5");
    type("Limit per day", "3");
    clickIn("Change asset");

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(api.to("PATCH", "/v1/settings")[0]!.body).toEqual({
      settlementAssetId: "nep141:wrap.near",
      refundMaxPerTx: "1.5",
      refundMaxPerDay: "3",
    });
    expect(await screen.findByText("Settlement asset changed")).toBeTruthy();
  });

  it("does not offer the asset already in use, and says when nothing matches", async () => {
    mockApi({ "GET /v1/tokens": { body: tokens } });
    openAssetDialog();
    type("Find an asset", "usdc");
    // Only USDC on Base is left to choose: USDC on NEAR is the current asset.
    expect(await dialog().findByRole("button", { name: /USDC on Base/ })).toBeTruthy();
    expect(dialog().queryByRole("button", { name: /USDC on NEAR/ })).toBeNull();
    type("Find an asset", "zzz");
    expect(dialog().getByText("No asset matches that.")).toBeTruthy();
  });

  it("shows the server's reason when it refuses", async () => {
    mockApi({
      "GET /v1/tokens": { body: tokens },
      "PATCH /v1/settings": {
        status: 409,
        body: { error: { code: "money_in_motion", message: "Finish or cancel the 1 refund still open first." } },
      },
    });
    const reload = openAssetDialog();
    type("Find an asset", "wnear");
    fireEvent.click(await dialog().findByRole("button", { name: /wNEAR on NEAR/ }));
    clickIn("Change asset");
    expect((await dialog().findByRole("alert")).textContent).toBe("Finish or cancel the 1 refund still open first.");
    expect(reload).not.toHaveBeenCalled();
  });

  it("will not start while money is in motion", () => {
    mockApi({ "GET /v1/tokens": { body: tokens } });
    openAssetDialog(
      settingsWith({
        settlementLocked:
          "1 open invoice has a payment under way. Wait for it to be paid or to expire, or cancel it, first.",
      }),
    );
    expect(dialog().getByText(/1 open invoice has a payment under way/)).toBeTruthy();
    expect((dialog().getByLabelText("Find an asset") as HTMLInputElement).disabled).toBe(true);
    expect((dialog().getByRole("button", { name: "Change asset" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("an invoice paid before the settlement account or asset changed", () => {
  it("has no Refund button, and says where the refund has to come from", async () => {
    mockApi({ "GET /v1/invoices/inv_old": { body: invoiceDetail({ refundableHere: false }) } });
    showInvoice();
    expect(await screen.findByRole("note")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toMatch(/paid to old-shop\.near in USDC/);
    expect(screen.getByRole("note").textContent).toMatch(/can.t refund it from here/);
    expect(screen.queryByRole("button", { name: "Refund" })).toBeNull();
  });

  it("keeps the Refund button for an invoice paid to the current account", async () => {
    mockApi({ "GET /v1/invoices/inv_old": { body: invoiceDetail({ refundableHere: true }) } });
    showInvoice();
    expect(await screen.findByRole("button", { name: "Refund" })).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
  });
});

describe("long account ids", () => {
  it("wrap instead of pushing the page wider than a phone: an implicit account is 64 characters with no break", () => {
    const implicit = "a".repeat(64);
    mockApi({});
    show(settingsWith({ account: implicit }));
    const sentence = screen.getByText(/The wallet has to be signed in as the settlement account/);
    expect(sentence.textContent).toContain(implicit);
    expect(sentence.className).toContain("break-words");
  });
});

describe("the history of changes", () => {
  it("shows slippage in percent and the payment window in minutes, not as stored", () => {
    show(
      settingsWith({
        history: [
          { setting: "slippageBps", from: "100", to: "50", changedAt: "2026-11-01T10:00:00.000Z" },
          { setting: "attemptDeadlineMinutes", from: "30", to: "45", changedAt: "2026-11-01T10:00:00.000Z" },
        ],
      }),
    );
    expect(screen.getByText("1%")).toBeTruthy();
    expect(screen.getByText("0.5%")).toBeTruthy();
    expect(screen.getByText("30 min")).toBeTruthy();
    expect(screen.getByText("45 min")).toBeTruthy();
  });
});
