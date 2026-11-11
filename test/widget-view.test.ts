// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createController } from "../widget/src/controller.js";
import type { TokensPayload } from "../widget/src/tokens.js";
import type { PublicAttempt, PublicInvoice } from "../widget/src/types.js";
import { STYLES } from "../widget/src/styles.js";
import { mountView } from "../widget/src/view.js";
import { USDC_BASE } from "./helpers/oneclickData.js";
import { EVM, apiError, attempt, invoice, payload } from "./helpers/widgetData.js";

const flush = () => vi.advanceTimersByTimeAsync(0);

const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

function mount(
  options: {
    inline?: boolean;
    invoice?: PublicInvoice;
    invoiceFails?: boolean;
    tokens?: TokensPayload;
    iconOrigin?: string;
  } = {},
) {
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.append(host);

  const api = {
    invoice: vi.fn<() => Promise<PublicInvoice>>(async () => {
      if (options.invoiceFails) throw apiError(0, "network", "Could not reach the payment server.");
      return options.invoice ?? invoice();
    }),
    tokens: vi.fn<() => Promise<TokensPayload>>(async () => options.tokens ?? payload),
    createAttempt: vi.fn<(id: string, body: { originAsset: string; refundTo: string }) => Promise<PublicAttempt>>(
      async () => attempt(),
    ),
    attempt: vi.fn<(id: string) => Promise<PublicAttempt>>(async () => attempt()),
  };
  const onPaid = vi.fn<(attempt: PublicAttempt) => void>();
  const onClose = vi.fn<() => void>();
  const controller = createController({ api, invoiceId: "inv_1", onPaid, pollMs: 3000 });
  const view = mountView(host, controller, {
    inline: options.inline ?? false,
    onClose,
    ...(options.iconOrigin ? { iconOrigin: options.iconOrigin } : {}),
  });
  const root = host.shadowRoot!;

  const q = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector);
  const all = <T extends Element = HTMLElement>(selector: string) => [...root.querySelectorAll<T>(selector)];
  const text = () => root.querySelector(".body")!.textContent ?? "";
  /** The step's title in the header, and which step of the progress bar is current (-1: no bar). */
  const title = () => root.querySelector(".head .title")!.textContent ?? "";
  const stepsShown = () => all(".steps .step").length;
  const currentStep = () => all(".steps .step").findIndex((s) => s.getAttribute("aria-current") === "step");
  const foot = () => root.querySelector(".foot")?.textContent ?? "";
  const buttonWithText = (label: string) => all("button").find((b) => b.textContent?.trim().startsWith(label));
  const submit = () => q("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  const tokenButton = (symbol: string) => all(".token").find((b) => b.querySelector(".sym")?.textContent === symbol)!;
  const networkButton = (name: string) => all(".network").find((b) => b.querySelector(".name")?.textContent === name)!;

  /** Walk to the pay screen on Base USDC. */
  async function toPayScreen(next: PublicAttempt = attempt()) {
    api.createAttempt.mockResolvedValue(next);
    await flush();
    buttonWithText("Pay with crypto")!.click();
    networkButton("Base").click();
    tokenButton("USDC").click();
    type(q<HTMLInputElement>("input#refund")!, EVM);
    submit();
    await flush();
  }

  return {
    api,
    controller,
    view,
    host,
    root,
    onPaid,
    onClose,
    q,
    all,
    text,
    title,
    stepsShown,
    currentStep,
    foot,
    buttonWithText,
    type,
    submit,
    tokenButton,
    networkButton,
    toPayScreen,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T10:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("summary", () => {
  it("shows what is being paid for, the amount and a running expiry countdown", async () => {
    const v = mount();
    await flush();

    expect(v.text()).toContain("Coffee");
    expect(v.text()).toContain("5 USDC");
    expect(v.q("[data-until]")!.textContent).toBe("1h 00m");

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(v.q("[data-until]")!.textContent).toBe("55:00");
  });

  it("renders a merchant-supplied description as text, never as markup", async () => {
    const v = mount({ invoice: { ...invoice(), description: '<img src=x onerror="window.xssFlag=1"><b>bold</b>' } });
    await flush();

    expect(v.q("img")).toBeNull();
    expect(v.q("b")).toBeNull();
    expect(v.text()).toContain('<img src=x onerror="window.xssFlag=1">');
    expect((window as unknown as { xssFlag?: number }).xssFlag).toBeUndefined();
  });

  it("explains an invoice that cannot be paid, with a retry only for a connection failure", async () => {
    const expired = mount({ invoice: invoice("expired") });
    await flush();
    expect(expired.text()).toContain("Invoice expired");
    expect(expired.buttonWithText("Try again")).toBeUndefined();

    const down = mount({ invoiceFails: true });
    await flush();
    expect(down.text()).toContain("Could not reach the payment server.");
    down.buttonWithText("Try again")!.click();
    await flush();
    expect(down.api.invoice).toHaveBeenCalledTimes(2);
  });
});

describe("choosing a network, a token and an address", () => {
  it("lists networks popular first, filters them by search, and keeps the search box while typing", async () => {
    const v = mount();
    await flush();
    v.buttonWithText("Pay with crypto")!.click();

    expect(
      v
        .all(".network .name")
        .map((e) => e.textContent)
        .slice(0, 4),
    ).toEqual(["Base", "Arbitrum", "Ethereum", "Solana"]);
    expect(v.all(".token")).toHaveLength(0); // tokens come after the network

    const search = v.q<HTMLInputElement>("input[type=search]")!;
    v.type(search, "so");
    v.type(search, "sol");
    expect(v.q<HTMLInputElement>("input[type=search]")).toBe(search); // same element: focus and caret survive
    expect(v.all(".network .name").map((e) => e.textContent)).toEqual(["Solana"]);

    v.type(search, "zzzz");
    expect(v.text()).toContain('No networks match "zzzz"');
  });

  it("then lists only that network's tokens, and filters them by search", async () => {
    const v = mount();
    await flush();
    v.buttonWithText("Pay with crypto")!.click();
    v.networkButton("Base").click();

    expect(v.title()).toBe("Choose a token");
    expect(v.all(".network")).toHaveLength(0);
    const symbols = v.all(".token .sym").map((e) => e.textContent);
    expect(symbols).toContain("USDC");
    expect(symbols).not.toContain("SOL");

    const search = v.q<HTMLInputElement>("input[type=search]")!;
    v.type(search, "usd");
    v.type(search, "usdc");
    expect(v.q<HTMLInputElement>("input[type=search]")).toBe(search);
    expect(v.all(".token").every((t) => /usdc/i.test(t.textContent ?? ""))).toBe(true);

    v.type(search, "zzzz");
    expect(v.text()).toContain('No tokens match "zzzz"');
  });

  it("marks look-alike tokens with their contract", async () => {
    const v = mount();
    await flush();
    v.buttonWithText("Pay with crypto")!.click();
    v.networkButton("NEAR").click();
    const nearUsdt = v
      .all(".token")
      .filter((t) => t.querySelector(".sym")?.textContent === "USDT" && t.querySelector("small"));
    expect(nearUsdt.map((t) => t.querySelector("small")!.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("usdt.tether-token.near")]),
    );
  });

  it("asks for a refund address on the chosen chain, with the warning, and refuses a bad one without calling the server", async () => {
    const v = mount();
    await flush();
    v.buttonWithText("Pay with crypto")!.click();
    v.networkButton("Base").click();
    v.tokenButton("USDC").click();

    expect(v.text()).toContain("Refund address on Base");
    expect(v.text()).toContain("funds return here");
    expect(v.text()).toContain("Don't use an exchange deposit address");

    const input = v.q<HTMLInputElement>("input#refund")!;
    v.type(input, "0x123");
    expect(v.q(".note.error")).toBeNull(); // not scolded while typing
    v.submit();
    expect(v.q(".note.error")!.textContent).toContain("0x followed by 40");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(v.q<HTMLInputElement>("input#refund")).toBe(input);
    expect(v.api.createAttempt).not.toHaveBeenCalled();
  });

  it("disables the button while the address is being created", async () => {
    const v = mount();
    let finish!: (a: PublicAttempt) => void;
    v.api.createAttempt.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await flush();
    v.buttonWithText("Pay with crypto")!.click();
    v.networkButton("Base").click();
    v.tokenButton("USDC").click();
    v.type(v.q<HTMLInputElement>("input#refund")!, EVM);
    v.submit();

    const button = v.q<HTMLButtonElement>("button[type=submit]")!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Creating");

    finish(attempt());
    await flush();
    expect(v.text()).toContain("Send exactly");
  });
});

describe("paying", () => {
  it("shows exactly what to send, the deposit address, a QR code and a deadline countdown", async () => {
    const v = mount();
    await v.toPayScreen();
    await vi.advanceTimersByTimeAsync(10);

    expect(v.text()).toContain("5.051529 USDC");
    expect(v.text()).toContain("on Base");
    expect(v.all(".copy-row .value").map((e) => e.textContent)).toEqual([
      "5.051529",
      expect.stringMatching(/^0xDEPOSIT/),
    ]);
    expect(v.q(".qr svg")).not.toBeNull();
    expect(v.q("[data-until]")!.textContent).toBe("30:00");
    expect(v.text()).toContain("Waiting for your payment");
  });

  it("makes a required memo impossible to miss", async () => {
    const v = mount();
    await v.toPayScreen({ ...attempt(), depositMemo: "987654", chain: "stellar" });
    expect(v.text()).toContain("Memo (required)");
    expect(v.q(".copy-row.memo .value")!.textContent).toBe("987654");
    expect(v.q(".note.warn")!.textContent).toContain("Include this memo");
  });

  it("does not rebuild the screen on a poll that changes nothing, so a text selection survives", async () => {
    const v = mount();
    const a = attempt();
    await v.toPayScreen(a);
    v.api.attempt.mockResolvedValue({ ...a });
    const address = v.q(".copy-row .value")!;

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(v.api.attempt).toHaveBeenCalledTimes(2);
    expect(v.q(".copy-row .value")).toBe(address);
  });

  it("shows confirmation with a safe explorer link once the deposit is seen", async () => {
    const v = mount();
    const a = attempt();
    await v.toPayScreen(a);
    v.api.attempt.mockResolvedValue({
      ...a,
      status: "confirming",
      txLinks: [{ hash: "0xabc", explorerUrl: "https://basescan.org/tx/0xabc" }],
    });

    await vi.advanceTimersByTimeAsync(3000);

    expect(v.text()).toContain("Payment detected");
    expect(v.text()).toContain("about 35 seconds");
    const link = v.q<HTMLAnchorElement>("a.link")!;
    expect(link.textContent).toBe("View transaction on basescan.org");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(v.buttonWithText("Pay with a different token")).toBeUndefined(); // money is on its way
  });

  it.each(["refunded", "failed"] as const)(
    "hides the deposit address once the attempt is %s, so nobody sends to a dead address",
    async (status) => {
      const v = mount();
      const a = attempt();
      await v.toPayScreen(a);
      v.api.attempt.mockResolvedValue({ ...a, status });
      await vi.advanceTimersByTimeAsync(3000);

      expect(v.q(".copy-row")).toBeNull();
      expect(v.q(".qr")).toBeNull();
      v.buttonWithText("Try again")!.click();
      expect(v.title()).toBe("Choose a token");
    },
  );

  it("lets the payer switch token while still waiting", async () => {
    const v = mount();
    await v.toPayScreen();
    v.buttonWithText("Pay with a different token")!.click();
    expect(v.title()).toBe("Choose a token");
  });

  it("shows a quiet connection warning without losing the payment details", async () => {
    const v = mount();
    await v.toPayScreen();
    v.api.attempt.mockRejectedValue(apiError(0, "network"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(v.text()).toContain("Connection problem. Retrying");
    expect(v.q(".copy-row")).not.toBeNull();
  });
});

describe("paid", () => {
  it("confirms the payment and calls onPaid, with a Close button in a modal", async () => {
    const v = mount();
    const a = attempt();
    await v.toPayScreen(a);
    v.api.attempt.mockResolvedValue({ ...a, status: "paid", invoiceStatus: "paid" });

    await vi.advanceTimersByTimeAsync(3000);

    expect(v.text()).toContain("Payment received");
    expect(v.text()).toContain("5 USDC paid");
    expect(v.onPaid).toHaveBeenCalledTimes(1);
    v.buttonWithText("Close")!.click();
    expect(v.onClose).toHaveBeenCalledTimes(1);
  });

  it("has no Close button and no x when rendered inline in a page", async () => {
    const v = mount({ inline: true, invoice: invoice("paid") });
    await flush();
    expect(v.text()).toContain("Payment received");
    expect(v.buttonWithText("Close")).toBeUndefined();
    expect(v.q(".x")).toBeNull();
  });
});

describe("modal behaviour", () => {
  it("closes on Escape and on a click outside the card, but not on a click inside it", async () => {
    const v = mount();
    await flush();

    v.q(".card")!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(v.onClose).not.toHaveBeenCalled();

    v.q(".overlay")!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(v.onClose).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(v.onClose).toHaveBeenCalledTimes(2);
  });

  it("marks itself as a modal dialog for assistive technology", async () => {
    const v = mount();
    await flush();
    const dialog = v.q(".card")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("ignores Escape when inline, and stops listening after destroy", async () => {
    const inline = mount({ inline: true });
    await flush();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(inline.onClose).not.toHaveBeenCalled();

    const modal = mount();
    await flush();
    modal.view.destroy();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(modal.onClose).not.toHaveBeenCalled();
    expect(modal.root.childElementCount).toBe(0);
  });
});

describe("integration of the pieces", () => {
  it("is wired to the real controller: picking Base USDC creates an attempt for that asset", async () => {
    const v = mount();
    await v.toPayScreen();
    expect(v.api.createAttempt).toHaveBeenCalledWith("inv_1", { originAsset: USDC_BASE, refundTo: EVM });
  });
});

describe("the window around every step", () => {
  it("titles each step in the header, and says when the payment is being confirmed", async () => {
    const v = mount();
    await flush();
    expect(v.title()).toBe("Payment");
    v.buttonWithText("Pay with crypto")!.click();
    expect(v.title()).toBe("Choose a network");
    v.networkButton("Base").click();
    expect(v.title()).toBe("Choose a token");
    v.tokenButton("USDC").click();
    expect(v.title()).toBe("Refund address");

    const a = attempt();
    v.api.createAttempt.mockResolvedValue(a);
    v.type(v.q<HTMLInputElement>("input#refund")!, EVM);
    v.submit();
    await flush();
    expect(v.title()).toBe("Send payment");

    v.api.attempt.mockResolvedValue({ ...a, status: "confirming" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(v.title()).toBe("Confirming payment");

    v.api.attempt.mockResolvedValue({ ...a, status: "paid", invoiceStatus: "paid" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(v.title()).toBe("Payment");
    expect(v.q(".body h2")!.textContent).toBe("Payment received");
  });

  it("shows a back arrow only where going back is allowed, and it goes back one step", async () => {
    const v = mount();
    await flush();
    expect(v.q("button.back")).toBeNull(); // the first screen has nowhere to go

    v.buttonWithText("Pay with crypto")!.click();
    v.q<HTMLButtonElement>("button.back")!.click();
    expect(v.title()).toBe("Payment");

    v.buttonWithText("Pay with crypto")!.click();
    v.networkButton("Base").click();
    v.q<HTMLButtonElement>("button.back")!.click();
    expect(v.title()).toBe("Choose a network");

    v.networkButton("Base").click();
    v.tokenButton("USDC").click();
    v.q<HTMLButtonElement>("button.back")!.click();
    expect(v.title()).toBe("Choose a token");

    const a = attempt();
    v.tokenButton("USDC").click();
    v.api.createAttempt.mockResolvedValue(a);
    v.type(v.q<HTMLInputElement>("input#refund")!, EVM);
    v.submit();
    await flush();
    expect(v.q("button.back")!.getAttribute("aria-label")).toBe("Back");

    v.api.attempt.mockResolvedValue({ ...a, status: "confirming" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(v.q("button.back")).toBeNull(); // money is on its way: no way back

    v.api.attempt.mockResolvedValue({ ...a, status: "paid", invoiceStatus: "paid" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(v.q("button.back")).toBeNull();
  });

  it("has no back arrow on an invoice that cannot be paid", async () => {
    const v = mount({ invoice: invoice("expired") });
    await flush();
    expect(v.q("button.back")).toBeNull();
  });

  it("shows four steps while choosing and paying, and marks the current one", async () => {
    const v = mount();
    await flush();
    expect(v.stepsShown()).toBe(0);

    v.buttonWithText("Pay with crypto")!.click();
    expect([v.stepsShown(), v.currentStep()]).toEqual([4, 0]);
    expect(v.all(".steps .step").map((s) => s.textContent)).toEqual(["Network", "Token", "Refund address", "Payment"]);

    v.networkButton("Base").click();
    expect(v.currentStep()).toBe(1);
    v.tokenButton("USDC").click();
    expect(v.currentStep()).toBe(2);

    v.type(v.q<HTMLInputElement>("input#refund")!, EVM);
    v.submit();
    await flush();
    expect(v.currentStep()).toBe(3);
    // The steps already done are filled in, the ones to come are not.
    expect(v.all(".steps .step").map((s) => s.classList.contains("on"))).toEqual([true, true, true, true]);
  });

  it("says who runs the checkout, under every step", async () => {
    const v = mount();
    await flush();
    const seen = [v.foot()];
    v.buttonWithText("Pay with crypto")!.click();
    seen.push(v.foot());
    v.networkButton("Base").click();
    v.tokenButton("USDC").click();
    seen.push(v.foot());
    expect(seen).toEqual(Array(3).fill("Powered by Tilll · Settled by NEAR Intents"));

    const expired = mount({ invoice: invoice("expired") });
    await flush();
    expect(expired.foot()).toBe("Powered by Tilll · Settled by NEAR Intents");
  });
});

describe("network and token rows", () => {
  it("show a badge tinted by network, the name and an arrow, and the badge is decoration only", async () => {
    const v = mount();
    await flush();
    v.buttonWithText("Pay with crypto")!.click();

    const base = v.networkButton("Base");
    const badge = base.querySelector(".badge")!;
    expect(badge.getAttribute("aria-hidden")).toBe("true");
    expect(badge.getAttribute("data-chain")).toBe("base");
    expect(badge.textContent).toBe("B");
    expect(base.querySelector(".go")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("show the token's badge and symbol on the token list", async () => {
    const v = mount();
    await flush();
    v.buttonWithText("Pay with crypto")!.click();
    v.networkButton("Base").click();

    const usdc = v.tokenButton("USDC");
    const badge = usdc.querySelector(".badge")!;
    expect(badge.getAttribute("aria-hidden")).toBe("true");
    expect(badge.textContent).toBe("U");
    expect(badge.getAttribute("data-chain")).toBe("base");
    expect(usdc.querySelector(".go")!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("while the payment address is being made", () => {
  it("greys the button out, shows a spinner in it, and takes both away when it is done", async () => {
    const v = mount();
    let finish!: (a: PublicAttempt) => void;
    v.api.createAttempt.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await flush();
    v.buttonWithText("Pay with crypto")!.click();
    v.networkButton("Base").click();
    v.tokenButton("USDC").click();
    v.type(v.q<HTMLInputElement>("input#refund")!, EVM);
    expect(v.q("button[type=submit] .spin")).toBeNull();

    v.submit();
    expect(v.q<HTMLButtonElement>("button[type=submit]")!.disabled).toBe(true);
    expect(v.q("button[type=submit] .spin")!.getAttribute("aria-hidden")).toBe("true");

    finish(attempt());
    await flush();
    expect(v.q("button[type=submit]")).toBeNull();
  });
});

/** The declarations of one rule in the widget's stylesheet, or "" when there is none. */
const rule = (selector: string) => {
  const css = STYLES.replace(/\s+/g, " ");
  const at = css.indexOf(` ${selector} {`);
  return at === -1 ? "" : css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
};

describe("the size of the window", () => {
  it("keeps the card within the screen, so a long token list scrolls inside it and the header and footer stay in view", () => {
    expect(rule(".card")).toMatch(/max-height: calc\(100vh - 32px\)/);
    expect(rule(".inline .card")).toMatch(/max-height: min\(720px, calc\(100vh - 32px\)\)/);
    expect(rule(".body")).toMatch(/overflow: auto/);
  });
});

describe("the look of the buttons", () => {
  it("is navy with white text, with a hover, a pressed, a focus and a disabled state", () => {
    expect(rule(".btn")).toMatch(/background: var\(--navy\)/);
    expect(rule(".btn")).toMatch(/color: #fff/);
    expect(rule(".btn:hover")).toMatch(/var\(--navy-hover\)/);
    expect(rule(".btn:active")).toMatch(/var\(--navy-active\)/);
    expect(rule(".btn:focus-visible")).toMatch(/outline: 2px solid var\(--ring\)/);
    expect(rule(".btn:disabled")).toMatch(/background: #e2e8f0/);
    expect(rule(".btn:disabled")).toMatch(/color: #94a3b8/);
    expect(rule(".btn:disabled")).toMatch(/cursor: not-allowed/);
    expect(STYLES).toMatch(/--navy: #0b1f3a/);
    expect(STYLES).toMatch(/--navy-hover: #1e3a5f/);
    expect(STYLES).toMatch(/--navy-active: #071426/);
    expect(STYLES).toMatch(/--ring: #6366f1/);
  });

  it("has no green button or link, and uses no inline style attribute", async () => {
    expect(STYLES).not.toMatch(/\.btn\.accent/);
    expect(rule(".link")).not.toMatch(/#0[45]\d{4}/); // no emerald
    expect(rule(".link")).toMatch(/var\(--navy\)/);
    const v = mount();
    await v.toPayScreen();
    expect(v.root.innerHTML).not.toMatch(/\sstyle="/);
    for (const button of v.all("button.btn")) expect(button.className).not.toMatch(/accent/);
  });
});

describe("the words on the first screen", () => {
  it("does not name what the merchant receives, and says what comes next", async () => {
    const v = mount();
    await flush();
    expect(v.text()).toContain("Pay from any supported chain.");
    expect(v.text()).not.toMatch(/merchant receives|USDC\./);
    expect(v.text()).toContain("No account needed. You'll choose a network and token, then a refund address.");
  });
});

describe("what sits under the payment details", () => {
  it("is centered: the deadline, the status, the connection note and the link to change token", async () => {
    const v = mount();
    await v.toPayScreen();
    const deadline = v.all("p.muted").find((p) => p.textContent?.startsWith("Pay within"))!;
    expect(deadline.classList.contains("center")).toBe(true);
    expect(rule(".status")).toMatch(/justify-content: center/);
    const change = v.buttonWithText("Pay with a different token")!;
    expect(change.parentElement!.classList.contains("center")).toBe(true);
    expect(rule(".center")).toMatch(/text-align: center/);
  });

  it("centers the transaction link and keeps it clear of the button below it", async () => {
    expect(rule(".links")).toMatch(/text-align: center/);
    expect(rule(".links")).toMatch(/margin: 12px 0 16px/);

    const v = mount();
    const a = attempt();
    await v.toPayScreen(a);
    v.api.attempt.mockResolvedValue({
      ...a,
      status: "paid",
      invoiceStatus: "paid",
      txLinks: [{ hash: "0xabc", explorerUrl: "https://basescan.org/tx/0xabc" }],
    });
    await vi.advanceTimersByTimeAsync(3000);
    const links = v.q(".links")!;
    expect(links.nextElementSibling!.textContent).toBe("Close"); // the margin on .links is what keeps them apart
  });
});

/** The payload with images named, as a server that fetches them would send it. */
const withIcons: TokensPayload = {
  ...payload,
  chains: Object.fromEntries(
    Object.entries(payload.chains).map(([chain, list]) => [
      chain,
      list.map((t) => ({ ...t, icon: t.symbol === "USDC" ? "usd-coin" : `coin-${t.symbol.toLowerCase()}` })),
    ]),
  ),
  chainIcons: ["base", "sol"],
};

describe("images", () => {
  it("shows a network's image from the Tilll server it came from, lazily, as decoration", async () => {
    const v = mount({ tokens: withIcons, iconOrigin: "https://pay.example/" });
    await flush();
    v.buttonWithText("Pay with crypto")!.click();

    const img = v.networkButton("Base").querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://pay.example/pay/icons/chain/base");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(v.networkButton("Arbitrum").querySelector("img")).toBeNull(); // the server named no image for it
  });

  it("shows a token's image, and none when the server names none", async () => {
    const v = mount({ tokens: withIcons, iconOrigin: "https://pay.example" });
    await flush();
    v.buttonWithText("Pay with crypto")!.click();
    v.networkButton("Base").click();
    expect(v.tokenButton("USDC").querySelector("img")!.getAttribute("src")).toBe(
      "https://pay.example/pay/icons/token/usd-coin",
    );

    const plain = mount();
    await flush();
    plain.buttonWithText("Pay with crypto")!.click();
    plain.networkButton("Base").click();
    expect(plain.all("img")).toHaveLength(0);
  });

  it("uses a path on its own server when it was not told where it came from", async () => {
    const v = mount({ tokens: withIcons });
    await flush();
    v.buttonWithText("Pay with crypto")!.click();
    expect(v.networkButton("Base").querySelector("img")!.getAttribute("src")).toBe("/pay/icons/chain/base");
  });

  it("keeps the letter until the picture loads, and goes back to it when the picture fails", async () => {
    const v = mount({ tokens: withIcons });
    await flush();
    v.buttonWithText("Pay with crypto")!.click();
    const base = v.networkButton("Base");
    const badge = base.querySelector(".badge")!;
    const img = badge.querySelector("img")!;
    expect(badge.classList.contains("has-img")).toBe(false);
    expect(badge.textContent).toBe("B");

    img.dispatchEvent(new Event("load"));
    expect(badge.classList.contains("has-img")).toBe(true);

    const sol = v.networkButton("Solana").querySelector(".badge")!;
    sol.querySelector("img")!.dispatchEvent(new Event("error"));
    expect(sol.querySelector("img")).toBeNull();
    expect(sol.classList.contains("has-img")).toBe(false);
    expect(sol.textContent).toBe("S");
  });

  it("shows the chosen token's image beside its name on the address step", async () => {
    const v = mount({ tokens: withIcons });
    await flush();
    v.buttonWithText("Pay with crypto")!.click();
    v.networkButton("Base").click();
    v.tokenButton("USDC").click();
    expect(v.q(".picked img")!.getAttribute("src")).toBe("/pay/icons/token/usd-coin");
  });

  it("hides the letter once a picture is showing, and clips the picture to the circle", () => {
    expect(rule(".badge")).toMatch(/overflow: hidden/);
    expect(rule(".badge.has-img")).toMatch(/color: transparent/);
    expect(rule(".badge img")).toMatch(/object-fit: cover/);
  });
});
