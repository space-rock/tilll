import { validateAddress, type AddressCheck } from "../../src/validate/addresses.js";
import { TilllApiError, type Api } from "./api.js";
import { buildChoices, filterChains, filterTokens, type ChainChoice, type TokenChoice } from "./tokens.js";
import type { PublicAttempt, PublicInvoice } from "./types.js";

export type Step = "loading" | "summary" | "network" | "token" | "address" | "pay" | "paid" | "unavailable";

export interface Unavailable {
  kind: "expired" | "canceled" | "not_found" | "error";
  message: string;
}

export interface ControllerState {
  step: Step;
  invoice: PublicInvoice | null;
  /** Every chain and token on offer, popular first. */
  choices: ChainChoice[];
  /** `choices` narrowed by `search`. */
  visibleChains: ChainChoice[];
  /** The network the payer chose, whose tokens they are now picking from. */
  network: ChainChoice | null;
  /** The chosen network's tokens, narrowed by `search`. */
  visibleTokens: TokenChoice[];
  search: string;
  selected: { chain: ChainChoice; token: TokenChoice } | null;
  /** The address as typed. */
  refundTo: string;
  addressCheck: AddressCheck | null;
  /** Show `addressCheck`'s reason. Off until the payer submits, so typing is not scolded. */
  showAddressError: boolean;
  submitting: boolean;
  /** A message from the last action that failed. */
  error: string | null;
  attempt: PublicAttempt | null;
  /** The last status poll failed. The widget keeps trying. */
  connectionIssue: boolean;
  unavailable: Unavailable | null;
}

export interface ControllerDeps {
  api: Pick<Api, "invoice" | "tokens" | "createAttempt" | "attempt">;
  invoiceId: string;
  /** Called once, when the attempt the payer is watching is paid. */
  onPaid?: (attempt: PublicAttempt) => void;
  /** How often to ask the server about the attempt. PLAN section 8: every 3 seconds. */
  pollMs?: number;
}

const GENERIC_ERROR = "Something went wrong. Please try again.";

/**
 * All of the widget's behaviour with no DOM in it: which step the payer is on, what they have chosen, and the
 * conversation with the server. The view only renders `getState()` and calls these actions.
 */
export function createController(deps: ControllerDeps) {
  const pollMs = deps.pollMs ?? 3000;
  const listeners = new Set<(state: ControllerState) => void>();
  let destroyed = false;
  let paidNotified = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  let state: ControllerState = {
    step: "loading",
    invoice: null,
    choices: [],
    visibleChains: [],
    network: null,
    visibleTokens: [],
    search: "",
    selected: null,
    refundTo: "",
    addressCheck: null,
    showAddressError: false,
    submitting: false,
    error: null,
    attempt: null,
    connectionIssue: false,
    unavailable: null,
  };

  function set(patch: Partial<ControllerState>) {
    if (destroyed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  const unavailable = (kind: Unavailable["kind"], message: string) =>
    set({ step: "unavailable", unavailable: { kind, message } });

  function fail(error: unknown) {
    if (error instanceof TilllApiError && error.code === "not_found") {
      return unavailable("not_found", "We could not find this invoice. Check the link you were given.");
    }
    unavailable("error", error instanceof TilllApiError ? error.message : GENERIC_ERROR);
  }

  function showInvoice(invoice: PublicInvoice, extra: Partial<ControllerState> = {}) {
    switch (invoice.status) {
      case "open":
        return set({ ...extra, invoice, step: "summary", unavailable: null });
      case "paid":
        return set({ ...extra, invoice, step: "paid", unavailable: null });
      case "expired":
        return set({
          ...extra,
          invoice,
          step: "unavailable",
          unavailable: { kind: "expired", message: "This invoice has expired." },
        });
      case "canceled":
        return set({
          ...extra,
          invoice,
          step: "unavailable",
          unavailable: { kind: "canceled", message: "This invoice was canceled." },
        });
    }
  }

  async function load() {
    try {
      const [invoice, tokens] = await Promise.all([deps.api.invoice(deps.invoiceId), deps.api.tokens()]);
      const choices = buildChoices(tokens);
      showInvoice(invoice, { choices, visibleChains: choices });
    } catch (error) {
      fail(error);
    }
  }

  const check = (selected: ControllerState["selected"], text: string): AddressCheck | null =>
    selected ? validateAddress(selected.chain.chain, text.trim()) : null;

  // ---- watching the payment ----

  function schedule() {
    clearTimeout(timer);
    if (destroyed || !state.attempt) return;
    timer = setTimeout(() => void poll(), pollMs);
  }

  async function poll() {
    const watched = state.attempt;
    if (destroyed || !watched) return;
    try {
      const next = await deps.api.attempt(watched.id);
      if (destroyed || state.attempt?.id !== watched.id) return; // the payer moved on while we waited
      set({ attempt: next, connectionIssue: false });

      if (next.status === "paid" || next.invoiceStatus === "paid") {
        set({ step: "paid" });
        if (next.status === "paid" && !paidNotified) {
          paidNotified = true;
          deps.onPaid?.(next);
        }
        return;
      }
      if (next.status === "refunded" || next.status === "failed") return;
      if (
        (next.invoiceStatus === "expired" || next.invoiceStatus === "canceled") &&
        (next.status === "awaiting" || next.status === "superseded")
      ) {
        unavailable(
          next.invoiceStatus,
          next.invoiceStatus === "expired" ? "This invoice has expired." : "This invoice was canceled.",
        );
        return;
      }
    } catch (error) {
      if (destroyed || state.attempt?.id !== watched.id) return;
      if (error instanceof TilllApiError && error.code === "not_found") return fail(error);
      set({ connectionIssue: true });
    }
    schedule();
  }

  // ---- creating the attempt ----

  async function handleSubmitError(error: unknown) {
    const code = error instanceof TilllApiError ? error.code : "";
    const message = error instanceof TilllApiError ? error.message : GENERIC_ERROR;
    if (code === "invoice_not_open" || code === "invoice_expired") {
      set({ submitting: false });
      try {
        showInvoice(await deps.api.invoice(deps.invoiceId));
      } catch (inner) {
        fail(inner);
      }
      return;
    }
    if (code === "pair_unavailable" || code === "unsupported_asset") {
      return set({ submitting: false, step: "token", selected: null, error: message });
    }
    set({
      submitting: false,
      error: message,
      showAddressError: code === "invalid_refund_address" || state.showAddressError,
    });
  }

  const loaded = load();

  return {
    /** Settles when the first load has finished. */
    loaded,

    getState: () => state,

    subscribe(listener: (state: ControllerState) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** Reload after a failure. */
    retry(): Promise<void> {
      if (state.step !== "unavailable" || state.unavailable?.kind !== "error") return Promise.resolve();
      set({ step: "loading", unavailable: null });
      return load();
    },

    start() {
      if (state.step === "summary") {
        set({ step: "network", error: null, search: "", network: null, visibleChains: state.choices });
      }
    },

    back() {
      if (state.step === "token") {
        set({ step: "network", error: null, search: "", network: null, visibleChains: state.choices });
      } else if (state.step === "network") {
        set({ step: "summary", error: null, search: "" });
      } else if (state.step === "address") {
        set({
          step: "token",
          error: null,
          showAddressError: false,
          search: "",
          visibleTokens: state.network?.tokens ?? [],
        });
      }
    },

    setSearch(search: string) {
      if (state.step === "network") set({ search, visibleChains: filterChains(state.choices, search) });
      else if (state.step === "token" && state.network) {
        set({ search, visibleTokens: filterTokens(state.network.tokens, search) });
      }
    },

    pickNetwork(chain: string) {
      if (state.step !== "network") return;
      const network = state.choices.find((c) => c.chain === chain);
      if (!network) return;
      set({ network, step: "token", error: null, search: "", visibleTokens: network.tokens });
    },

    pickToken(assetId: string) {
      if (state.step !== "token" && state.step !== "address") return;
      const chain = state.network;
      const token = chain?.tokens.find((t) => t.assetId === assetId);
      if (!chain || !token) return;
      const selected = { chain, token };
      set({
        selected,
        step: "address",
        error: null,
        showAddressError: false,
        addressCheck: check(selected, state.refundTo),
      });
    },

    setRefundTo(refundTo: string) {
      set({ refundTo, addressCheck: check(state.selected, refundTo), error: null });
    },

    async submitAddress() {
      const { selected, submitting } = state;
      if (destroyed || !selected || submitting) return;
      const refundTo = state.refundTo.trim();
      const addressCheck = validateAddress(selected.chain.chain, refundTo);
      if (!addressCheck.ok) return set({ addressCheck, showAddressError: true });

      set({ submitting: true, error: null });
      try {
        const attempt = await deps.api.createAttempt(deps.invoiceId, { originAsset: selected.token.assetId, refundTo });
        if (destroyed) return;
        set({ attempt, step: "pay", submitting: false, connectionIssue: false });
        schedule();
      } catch (error) {
        if (!destroyed) await handleSubmitError(error);
      }
    },

    /** Leave this address for another token. Not allowed once a deposit is confirming: money is on its way. */
    changeToken() {
      if (state.step !== "pay" || !state.attempt || state.attempt.status === "confirming") return;
      clearTimeout(timer);
      set({
        attempt: null,
        step: "token",
        error: null,
        submitting: false,
        connectionIssue: false,
        search: "",
        visibleTokens: state.network?.tokens ?? [],
      });
    },

    destroy() {
      destroyed = true;
      clearTimeout(timer);
      listeners.clear();
    },
  };
}

export type Controller = ReturnType<typeof createController>;
