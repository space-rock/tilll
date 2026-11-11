import QRCode from "qrcode";
import type { Controller, ControllerState, Step } from "./controller.js";
import { copyText, h, type Child } from "./dom.js";
import { formatCountdown, hostLabel, shorten } from "./format.js";
import { STYLES } from "./styles.js";
import { chainName } from "./tokens.js";
import type { PublicAttempt, TxLink } from "./types.js";

interface Screen {
  el: HTMLElement;
  /** Bring the screen up to date. Screens with inputs update in place so typing is never interrupted. */
  update(state: ControllerState): void;
}

export interface ViewOptions {
  /** Where the Tilll server is, so images load from it even when the checkout sits on another site. */
  iconOrigin?: string;
  /** Rendered inside the page (hosted page) instead of as a modal. */
  inline: boolean;
  onClose?: () => void;
}

const QR_CACHE = new Map<string, string>();

/**
 * A screen with no inputs: rebuilt from state when something it shows changes. `key` says what that is; without it
 * every update rebuilds. Rebuilding is avoided where possible so a poll does not wipe the payer's text selection.
 */
function simple(
  render: (state: ControllerState) => Child[],
  key?: (state: ControllerState) => string,
): (state: ControllerState) => Screen {
  return (state) => {
    const el = h("div");
    let last: string | undefined;
    const update = (s: ControllerState) => {
      const next = key?.(s);
      if (next !== undefined && next === last) return;
      last = next;
      el.replaceChildren(...render(s).filter((c): c is Node | string => !!c));
    };
    update(state);
    return { el, update };
  };
}

const note = (kind: "error" | "warn" | "ok" | "info", text: string) =>
  h("div", { class: `note ${kind}`, role: kind === "error" ? "alert" : undefined, text });

function countdown(label: string, until: string, centered = false) {
  return h(
    "p",
    { class: centered ? "muted center" : "muted" },
    `${label} `,
    h("strong", { "data-until": until, text: formatCountdown(Date.parse(until) - Date.now()) }),
  );
}

function txLinks(links: TxLink[]) {
  if (!links.length) return null;
  return h(
    "ul",
    { class: "links" },
    ...links.map((l) =>
      h(
        "li",
        {},
        h("a", {
          href: l.explorerUrl,
          target: "_blank",
          rel: "noopener noreferrer",
          class: "link",
          text: `View transaction on ${hostLabel(l.explorerUrl)}`,
        }),
      ),
    ),
  );
}

function copyRow(value: string, extraClass = "") {
  const button = h("button", { class: "copy-btn", type: "button", "aria-label": `Copy ${value}`, text: "Copy" });
  let reset: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener("click", () => {
    void copyText(value).then((ok) => {
      button.textContent = ok ? "Copied" : "Press Ctrl+C";
      clearTimeout(reset);
      reset = setTimeout(() => (button.textContent = "Copy"), 1500);
    });
  });
  return h("div", { class: `copy-row ${extraClass}`.trim() }, h("span", { class: "value mono", text: value }), button);
}

/** The QR code is drawn from the deposit address by the bundled `qrcode` library, and cached per address. */
function qrCode(address: string) {
  const el = h("div", { class: "qr", role: "img", "aria-label": "QR code of the deposit address" });
  const cached = QR_CACHE.get(address);
  const show = (svg: string) => {
    el.innerHTML = svg; // SVG produced by the library from the address; no user-supplied markup
  };
  if (cached) show(cached);
  else {
    void QRCode.toString(address, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#0B1F3A", light: "#FFFFFF" },
    })
      .then((svg) => {
        QR_CACHE.set(address, svg);
        show(svg);
      })
      .catch(() => el.replaceChildren());
  }
  return el;
}

function placeholderFor(chain: string, name: string): string {
  if (chain === "sol") return "Your Solana address";
  if (chain === "near") return "yourname.near";
  if (chain === "btc") return "bc1…";
  if (chain === "tron") return "T…";
  if (chain === "ltc" || chain === "doge" || chain === "xrp" || chain === "ton") return `Your ${name} address`;
  return "0x…";
}

/** The four steps of paying, shown as a bar under the header. */
const STEPS = ["Network", "Token", "Refund address", "Payment"];
const STEP_OF: Partial<Record<Step, number>> = { network: 0, token: 1, address: 2, pay: 3 };

function titleFor(state: ControllerState): string {
  switch (state.step) {
    case "network":
      return "Choose a network";
    case "token":
      return "Choose a token";
    case "address":
      return "Refund address";
    case "pay":
      if (state.attempt?.status === "awaiting") return "Send payment";
      return state.attempt?.status === "confirming" ? "Confirming payment" : "Payment";
    default:
      return "Payment";
  }
}

/** Mirrors the controller's own rule: a payer can step back, and leave a payment address, until money is on its way. */
const canGoBack = (state: ControllerState): boolean =>
  state.step === "network" ||
  state.step === "token" ||
  state.step === "address" ||
  (state.step === "pay" && !!state.attempt && state.attempt.status !== "confirming");

/** The first letter of a name, for the badge in front of it. */
const badgeLetter = (name: string): string => Array.from(name)[0]?.toUpperCase() ?? "?";

/**
 * A round badge tinted by network. The letter shows until the picture has loaded, and stays if it never does, so a
 * missing image (a server that could not fetch it, a page that blocks it) leaves nothing broken.
 */
function badge(chain: string, label: string, src?: string) {
  const el = h("span", { class: "badge", "aria-hidden": "true", "data-chain": chain, text: badgeLetter(label) });
  if (!src) return el;
  const img = h("img", {
    src,
    alt: "",
    width: "32",
    height: "32",
    loading: "lazy",
    decoding: "async",
    referrerpolicy: "no-referrer",
  });
  img.addEventListener("load", () => el.classList.add("has-img"));
  img.addEventListener("error", () => img.remove());
  el.append(img);
  return el;
}

export function mountView(host: HTMLElement, controller: Controller, options: ViewOptions): { destroy(): void } {
  const root = host.attachShadow({ mode: "open" });
  const imageBase = (options.iconOrigin ?? "").replace(/\/+$/, "");
  const imageOf = (kind: "token" | "chain", id: string | undefined) =>
    id ? `${imageBase}/pay/icons/${kind}/${encodeURIComponent(id)}` : undefined;
  const body = h("div", { class: "body" });
  const closeButton = options.inline
    ? null
    : h("button", {
        class: "nav x",
        type: "button",
        "aria-label": "Close",
        text: "×",
        onclick: () => options.onClose?.(),
      });
  const backButton = h("button", {
    class: "nav back",
    type: "button",
    "aria-label": "Back",
    text: "←",
    onclick: () => {
      const state = controller.getState();
      if (state.step === "pay") controller.changeToken();
      else controller.back();
    },
  });
  const backSlot = h("div", { class: "slot" });
  const title = h("h2", { class: "title" });
  const steps = h("ol", { class: "steps", "aria-label": "Progress" });
  const card = h(
    "div",
    {
      class: "card",
      role: "dialog",
      "aria-label": "Pay with crypto",
      tabindex: "-1",
      ...(options.inline ? {} : { "aria-modal": "true" }),
    },
    h("div", { class: "head" }, backSlot, title, h("div", { class: "slot" }, closeButton)),
    steps,
    body,
    h("footer", { class: "foot", text: "Powered by Tilll · Settled by NEAR Intents" }),
  );
  const frame = options.inline
    ? h("div", { class: "inline" }, card)
    : h("div", { class: "overlay", onclick: (e) => e.target === e.currentTarget && options.onClose?.() }, card);
  root.append(h("style", { text: STYLES }), frame);

  /** Everything around the step: its title, the back arrow and the progress bar. */
  function renderChrome(state: ControllerState) {
    title.textContent = titleFor(state);
    const wantsBack = canGoBack(state);
    if (wantsBack !== (backButton.parentElement === backSlot))
      backSlot.replaceChildren(...(wantsBack ? [backButton] : []));
    const current = STEP_OF[state.step];
    steps.replaceChildren(
      ...(current === undefined
        ? []
        : STEPS.map((label, i) =>
            h(
              "li",
              { class: i <= current ? "step on" : "step", ...(i === current ? { "aria-current": "step" } : {}) },
              h("span", { class: "sr", text: label }),
            ),
          )),
    );
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") options.onClose?.();
  };
  if (!options.inline) {
    document.addEventListener("keydown", onKey);
    card.focus();
  }

  // ---- screens ----

  const loading = simple(() => [
    h("div", { class: "spinner", role: "status", "aria-label": "Loading" }),
    h("p", { class: "muted center", text: "Loading invoice…" }),
  ]);

  const summary = simple((s) => {
    const invoice = s.invoice!;
    return [
      h("div", { class: "desc", text: invoice.description || "Payment" }),
      h("div", { class: "amount", text: `${invoice.amount} ${invoice.asset.symbol}` }),
      h("p", { text: "Pay from any supported chain." }),
      countdown("Invoice expires in", invoice.expiresAt),
      h("button", { class: "btn", type: "button", text: "Pay with crypto", onclick: () => controller.start() }),
      h("p", { class: "fine", text: "No account needed. You'll choose a network and token, then a refund address." }),
    ];
  });

  /** A screen with a search box above a list of buttons. The box is kept while typing; only the list is rebuilt. */
  const listScreen =
    (config: {
      intro: (state: ControllerState) => string;
      noun: "network" | "token";
      rows: (state: ControllerState) => HTMLElement[];
    }) =>
    (initial: ControllerState): Screen => {
      const search = h("input", {
        class: "text",
        type: "search",
        placeholder: `Search ${config.noun}s`,
        "aria-label": `Search ${config.noun}s`,
        autocomplete: "off",
        oninput: (e) => controller.setSearch((e.target as HTMLInputElement).value),
      });
      search.value = initial.search;
      const intro = h("p", { class: "muted" });
      const errorSlot = h("div");
      const list = h("div", { class: "rows" });
      const el = h("div", {}, intro, search, errorSlot, list);
      const update = (s: ControllerState) => {
        intro.textContent = config.intro(s);
        errorSlot.replaceChildren(...(s.error ? [note("error", s.error)] : []));
        const rows = config.rows(s);
        list.replaceChildren(
          ...(rows.length ? rows : [h("p", { class: "muted", text: `No ${config.noun}s match "${s.search}".` })]),
        );
      };
      update(initial);
      return { el, update };
    };

  const network = listScreen({
    noun: "network",
    intro: () => "Choose the network you are paying from.",
    rows: (s) =>
      s.visibleChains.map((chain) =>
        h(
          "button",
          { class: "network", type: "button", onclick: () => controller.pickNetwork(chain.chain) },
          badge(chain.chain, chain.name, chain.hasIcon ? imageOf("chain", chain.chain) : undefined),
          h("span", { class: "name", text: chain.name }),
          h("span", { class: "go", "aria-hidden": "true", text: "›" }),
        ),
      ),
  });

  const token = listScreen({
    noun: "token",
    intro: (s) => `Tokens on ${s.network?.name ?? ""}.`,
    rows: (s) =>
      s.visibleTokens.map((t) =>
        h(
          "button",
          { class: "token", type: "button", onclick: () => controller.pickToken(t.assetId) },
          badge(s.network?.chain ?? "", t.symbol, imageOf("token", t.icon)),
          h("span", { class: "sym", text: t.symbol }),
          t.ambiguous ? h("small", { class: "mono", text: shorten(t.detail, 14, 8) }) : null,
          h("span", { class: "go", "aria-hidden": "true", text: "›" }),
        ),
      ),
  });

  const address = (initial: ControllerState): Screen => {
    const selected = initial.selected!;
    const input = h("input", {
      class: "text mono",
      id: "refund",
      type: "text",
      placeholder: placeholderFor(selected.chain.chain, selected.chain.name),
      autocomplete: "off",
      spellcheck: "false",
      "aria-describedby": "refund-help",
      oninput: (e) => controller.setRefundTo((e.target as HTMLInputElement).value),
    });
    input.value = initial.refundTo;
    const messages = h("div");
    const submit = h("button", { class: "btn", type: "submit", text: "Continue" });
    const el = h(
      "form",
      { novalidate: true, onsubmit: (e) => (e.preventDefault(), void controller.submitAddress()) },
      h(
        "div",
        { class: "picked" },
        h(
          "span",
          { class: "pill" },
          badge(selected.chain.chain, selected.token.symbol, imageOf("token", selected.token.icon)),
          h("strong", { text: `${selected.token.symbol} on ${selected.chain.name}` }),
        ),
        h("button", { class: "link", type: "button", text: "Change", onclick: () => controller.back() }),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: "refund", text: `Refund address on ${selected.chain.name}` }),
        input,
      ),
      h("p", {
        id: "refund-help",
        class: "muted",
        text: "If anything goes wrong, or the merchant refunds you, funds return here.",
      }),
      note("warn", "Don't use an exchange deposit address. Use a wallet you control."),
      messages,
      submit,
    );
    const update = (s: ControllerState) => {
      const check = s.addressCheck;
      const bad = s.showAddressError && check && !check.ok;
      input.classList.toggle("bad", !!bad);
      input.setAttribute("aria-invalid", bad ? "true" : "false");
      messages.replaceChildren(
        ...[
          bad && check && !check.ok ? note("error", check.reason) : null,
          s.error && !(bad && check && !check.ok && s.error === check.reason) ? note("error", s.error) : null,
          check?.ok && !check.strict
            ? note("info", "We can't fully check addresses on this chain. Double-check it before you continue.")
            : null,
        ].filter((n): n is HTMLDivElement => !!n),
      );
      submit.disabled = s.submitting;
      submit.replaceChildren(
        ...(s.submitting
          ? [h("span", { class: "spin", "aria-hidden": "true" }), "Creating payment address…"]
          : ["Continue"]),
      );
    };
    update(initial);
    return { el, update };
  };

  const again = (label: string) =>
    h("button", { class: "btn", type: "button", text: label, onclick: () => controller.changeToken() });

  const statusBlock = (a: PublicAttempt, s: ControllerState): Child[] => {
    const issue = s.connectionIssue ? h("p", { class: "muted center", text: "Connection problem. Retrying…" }) : null;
    switch (a.status) {
      case "awaiting":
        return [
          h("div", { class: "status", role: "status" }, h("span", { class: "dot live" }), "Waiting for your payment…"),
          issue,
        ];
      case "confirming":
        return [
          h(
            "div",
            { class: "status", role: "status" },
            h("span", { class: "dot live" }),
            "Payment detected. Confirming…",
          ),
          h("p", { class: "muted center", text: `This usually takes about ${a.timeEstimate} seconds.` }),
          txLinks(a.txLinks),
          issue,
        ];
      case "underpaid":
        return [
          note(
            "warn",
            "We received less than the required amount. It is returned to your refund address after the deadline. To pay, start a new payment for the full amount.",
          ),
          txLinks(a.txLinks),
          again("Start a new payment"),
        ];
      case "refunded":
        return [
          note("info", "Your payment was returned to your refund address."),
          txLinks(a.txLinks),
          again("Try again"),
        ];
      case "failed":
        return [
          note(
            "error",
            "The payment could not be completed. If you sent funds, they are returned to your refund address.",
          ),
          txLinks(a.txLinks),
          again("Try again"),
        ];
      default:
        return [
          note("info", "This address was replaced by a newer one. Do not send funds to it."),
          again("Start over"),
        ];
    }
  };

  const pay = simple(
    (s) => {
      const a = s.attempt!;
      const live = a.status === "awaiting" || a.status === "confirming";
      const chain = chainName(a.chain);
      return [
        live
          ? h(
              "div",
              {},
              h(
                "div",
                { class: "pay-top" },
                h("div", { class: "muted", text: "Send exactly" }),
                h("div", { class: "amount mono", text: `${a.amountIn} ${a.symbol}` }),
                h("div", { class: "muted", text: `on ${chain}` }),
              ),
              copyRow(a.amountIn),
              qrCode(a.depositAddress),
              h("div", { class: "label", text: "Deposit address" }),
              copyRow(a.depositAddress),
              a.depositMemo
                ? h(
                    "div",
                    {},
                    h("div", { class: "label", text: "Memo (required)" }),
                    copyRow(a.depositMemo, "memo"),
                    note("warn", "Include this memo, or your payment may be lost."),
                  )
                : null,
              a.status === "awaiting" ? countdown("Pay within", a.deadline, true) : null,
            )
          : null,
        ...statusBlock(a, s),
        a.status === "awaiting"
          ? h(
              "p",
              { class: "center" },
              h("button", {
                class: "link",
                type: "button",
                text: "Pay with a different token",
                onclick: () => controller.changeToken(),
              }),
            )
          : null,
      ];
    },
    (s) => JSON.stringify([s.attempt?.id, s.attempt?.status, s.attempt?.txLinks.map((l) => l.hash), s.connectionIssue]),
  );

  const paid = simple((s) => {
    const invoice = s.invoice;
    return [
      h(
        "div",
        { class: "center" },
        h("div", { class: "tick", "aria-hidden": "true", text: "✓" }),
        h("h2", { text: "Payment received" }),
      ),
      h("p", {
        class: "center",
        text: invoice ? `${invoice.amount} ${invoice.asset.symbol} paid. Thank you.` : "Thank you.",
      }),
      s.attempt ? txLinks(s.attempt.txLinks) : null,
      options.inline
        ? null
        : h("button", { class: "btn secondary", type: "button", text: "Close", onclick: () => options.onClose?.() }),
    ];
  });

  const titles: Record<string, string> = {
    expired: "Invoice expired",
    canceled: "Invoice canceled",
    not_found: "Invoice not found",
    error: "Something went wrong",
  };
  const unavailable = simple((s) => {
    const u = s.unavailable!;
    return [
      h("h2", { text: titles[u.kind] ?? "Unavailable" }),
      h("p", { text: u.message }),
      u.kind === "error"
        ? h("button", { class: "btn", type: "button", text: "Try again", onclick: () => void controller.retry() })
        : null,
      options.inline
        ? null
        : h("button", { class: "link", type: "button", text: "Close", onclick: () => options.onClose?.() }),
    ];
  });

  const builders: Record<Step, (s: ControllerState) => Screen> = {
    loading,
    summary,
    network,
    token,
    address,
    pay,
    paid,
    unavailable,
  };

  // ---- rendering ----

  let current: { step: Step; screen: Screen } | null = null;
  function render(state: ControllerState) {
    renderChrome(state);
    if (!current || current.step !== state.step) {
      current = { step: state.step, screen: builders[state.step](state) };
      body.replaceChildren(current.screen.el);
    } else {
      current.screen.update(state);
    }
  }
  const unsubscribe = controller.subscribe(render);
  render(controller.getState());

  const tick = setInterval(() => {
    for (const el of root.querySelectorAll<HTMLElement>("[data-until]")) {
      el.textContent = formatCountdown(Date.parse(el.dataset.until ?? "") - Date.now());
    }
  }, 1000);

  return {
    destroy() {
      clearInterval(tick);
      unsubscribe();
      document.removeEventListener("keydown", onKey);
      root.replaceChildren();
    },
  };
}
