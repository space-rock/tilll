import { createApi } from "./api.js";
import { createController } from "./controller.js";
import type { PublicAttempt } from "./types.js";
import { mountView } from "./view.js";

export interface OpenOptions {
  invoiceId: string;
  /** Render inside this element instead of as a modal (the hosted page does this). */
  container?: HTMLElement;
  /** The Tilll server. Defaults to the origin this script was loaded from. */
  origin?: string;
  /**
   * For your UI only. It runs in the browser, so a buyer can fake it: fulfil orders on the signed `invoice.paid`
   * webhook, or after reading `GET /v1/invoices/:id` from your server.
   */
  onPaid?: (attempt: PublicAttempt) => void;
  onClose?: () => void;
}

export interface TilllHandle {
  close(): void;
}

declare global {
  interface Window {
    Tilll?: { open(options: OpenOptions): TilllHandle; version: string };
  }
}

// The widget talks to the server it was loaded from, so a merchant only has to add the script tag.
const script =
  document.currentScript instanceof HTMLScriptElement
    ? document.currentScript
    : document.querySelector<HTMLScriptElement>('script[src*="checkout.js"]');
const DEFAULT_ORIGIN = script?.src ? new URL(script.src).origin : location.origin;

let activeModal: TilllHandle | null = null;

function open(options: OpenOptions): TilllHandle {
  const inline = !!options.container;
  if (!inline) activeModal?.close();

  const host = document.createElement("div");
  (options.container ?? document.body).append(host);
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const previousOverflow = document.body.style.overflow;
  if (!inline) document.body.style.overflow = "hidden";

  const controller = createController({
    api: createApi({ origin: options.origin ?? DEFAULT_ORIGIN }),
    invoiceId: options.invoiceId,
    ...(options.onPaid ? { onPaid: options.onPaid } : {}),
  });

  let closed = false;
  const handle: TilllHandle = {
    close() {
      if (closed) return;
      closed = true;
      view.destroy();
      controller.destroy();
      host.remove();
      if (!inline) document.body.style.overflow = previousOverflow;
      if (activeModal === handle) activeModal = null;
      previousFocus?.focus();
      options.onClose?.();
    },
  };
  const view = mountView(host, controller, {
    inline,
    onClose: handle.close,
    iconOrigin: options.origin ?? DEFAULT_ORIGIN,
  });
  if (!inline) activeModal = handle;
  return handle;
}

// <button data-tilll-invoice="inv_...">Pay with crypto</button> opens the modal, including for buttons added later.
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-tilll-invoice]") : null;
  const invoiceId = target?.getAttribute("data-tilll-invoice");
  if (!invoiceId) return;
  event.preventDefault();
  open({ invoiceId });
});

// <div data-tilll-inline="inv_..."></div> renders the checkout in the page.
function mountInline() {
  for (const el of document.querySelectorAll<HTMLElement>("[data-tilll-inline]")) {
    const invoiceId = el.getAttribute("data-tilll-inline");
    if (!invoiceId || el.dataset.tilllMounted) continue;
    el.dataset.tilllMounted = "1";
    open({ invoiceId, container: el });
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountInline);
else mountInline();

window.Tilll = { open, version: "0.1.0" };
