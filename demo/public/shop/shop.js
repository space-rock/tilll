/*
 * The demo shop's page. It sends product ids and counts, never prices: the server prices the cart, creates the invoice
 * and, after payment, says whether the invoice is paid. The checkout's onPaid callback only tells this page to ask.
 */
(() => {
  "use strict";

  const SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const GLYPHS = {
    cup: `${SVG}<path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z"/><path d="M16 11h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3v2M12 3v2"/></svg>`,
    latte: `${SVG}<path d="M7 4h10l-1 15a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2L7 4z"/><path d="M7.6 10h8.8"/></svg>`,
    croissant: `${SVG}<path d="M3 15c1-5 4-8 9-8s8 3 9 8c-2 1-3-1-4-2-1 2-3 3-5 3s-4-1-5-3c-1 1-2 3-4 2z"/></svg>`,
    beans: `${SVG}<ellipse cx="9" cy="12" rx="4" ry="6.5" transform="rotate(-30 9 12)"/><ellipse cx="16" cy="12" rx="4" ry="6.5" transform="rotate(25 16 12)"/></svg>`,
  };

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "html") node.innerHTML = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children) if (child) node.append(child);
    return node;
  };
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;

  let products = [];
  let limits = { maxQty: 5, maxTotal: "3.00" };
  const cart = new Map(); // product id -> quantity. In memory only: this page keeps nothing in the browser.
  const state = { busy: false, error: "", done: null, confirming: false };
  let checkoutOpen = false;
  let opener = null;

  const productOf = (id) => products.find((p) => p.id === id);
  const totalCents = () => [...cart].reduce((sum, [id, qty]) => sum + (productOf(id)?.cents ?? 0) * qty, 0);
  const itemCount = () => [...cart.values()].reduce((a, b) => a + b, 0);

  function renderProducts() {
    const list = $("products");
    list.replaceChildren(
      ...products.map((p) =>
        el(
          "li",
          { class: "card" },
          el("div", { class: "glyph", html: GLYPHS[p.glyph] ?? GLYPHS.cup }),
          el("h3", { text: p.name }),
          el("p", { text: p.blurb }),
          el(
            "div",
            { class: "row" },
            el("span", { class: "price", text: money(p.cents) }),
            el("button", {
              class: "btn",
              type: "button",
              text: "Add",
              "aria-label": `Add ${p.name} to the cart`,
              onclick: (event) => add(p.id, event.currentTarget),
            }),
          ),
        ),
      ),
    );
  }

  function add(id, button) {
    const qty = cart.get(id) ?? 0;
    if (qty >= limits.maxQty) return;
    cart.set(id, qty + 1);
    state.error = "";
    renderCart();
    if (button) {
      button.textContent = "Added";
      setTimeout(() => (button.textContent = "Add"), 900);
    }
  }

  function setQty(id, qty) {
    if (qty <= 0) cart.delete(id);
    else cart.set(id, Math.min(qty, limits.maxQty));
    state.error = "";
    renderCart();
  }

  function renderCart() {
    const count = $("cart-count");
    count.textContent = String(itemCount());
    count.setAttribute("aria-live", "polite");
    renderDrawer();
  }

  function renderDrawer() {
    const body = $("drawer-body");
    const foot = $("drawer-foot");
    if (state.done) {
      body.replaceChildren(
        el(
          "div",
          { class: "done" },
          el("div", { class: "tick", "aria-hidden": "true", text: "✓" }),
          el("h3", { text: "Order confirmed" }),
          el("p", {
            text: `Your payment of $${Number(state.done.amount).toFixed(2)} arrived. Nothing ships: this is a demo.`,
          }),
          el("ul", {}, ...state.done.items.map((i) => el("li", { text: `${i.qty} × ${i.name}` }))),
        ),
      );
      foot.replaceChildren(
        el("button", { class: "btn block", type: "button", text: "Start a new order", onclick: newOrder }),
      );
      return;
    }
    if (state.confirming) {
      body.replaceChildren(el("p", { class: "empty", text: "Payment received. Confirming your order…" }));
      foot.replaceChildren();
      return;
    }
    if (cart.size === 0) {
      body.replaceChildren(el("p", { class: "empty", text: "Your cart is empty. Add something from the shop." }));
      foot.replaceChildren();
      return;
    }
    body.replaceChildren(
      ...[...cart].map(([id, qty]) => {
        const p = productOf(id);
        if (!p) return null;
        return el(
          "div",
          { class: "line" },
          el("div", { class: "name" }, p.name, el("small", { text: `${money(p.cents)} each` })),
          el(
            "div",
            { class: "stepper" },
            el("button", {
              type: "button",
              "aria-label": `Remove one ${p.name}`,
              text: "−",
              onclick: () => setQty(id, qty - 1),
            }),
            el("span", { text: String(qty), "aria-label": `${qty} in the cart` }),
            el("button", {
              type: "button",
              "aria-label": `Add one more ${p.name}`,
              text: "+",
              ...(qty >= limits.maxQty ? { disabled: "" } : {}),
              onclick: () => setQty(id, qty + 1),
            }),
          ),
          el("span", { class: "price", text: money(p.cents * qty) }),
        );
      }),
    );
    foot.replaceChildren(
      ...[
        el("div", { class: "total" }, el("span", { text: "Total" }), el("span", { text: money(totalCents()) })),
        state.error ? el("p", { class: "error", role: "alert", text: state.error }) : null,
        el("button", {
          class: "btn block",
          id: "pay",
          type: "button",
          text: state.busy ? "Opening checkout…" : "Pay with crypto",
          ...(state.busy ? { disabled: "" } : {}),
          onclick: checkout,
        }),
        el("p", {
          class: "hint",
          text: "You'll choose the network and token next. The checkout adds the swap fee on top.",
        }),
      ].filter(Boolean),
    );
  }

  async function checkout() {
    state.busy = true;
    state.error = "";
    renderDrawer();
    try {
      const response = await fetch("/shop/api/invoices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [...cart].map(([id, qty]) => ({ id, qty })) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || "Something went wrong. Try again in a moment.");
      openCheckout(data.invoiceId);
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Something went wrong. Try again in a moment.";
    } finally {
      state.busy = false;
      renderDrawer();
    }
  }

  function openCheckout(invoiceId) {
    if (!window.Tilll) {
      state.error = "The checkout didn't load. Reload the page and try again.";
      return;
    }
    checkoutOpen = true;
    window.Tilll.open({
      invoiceId,
      // The callback runs in this browser, so it can't confirm an order. It only tells the page to ask the server.
      onPaid: () => void confirmOrder(invoiceId),
      onClose: () => {
        checkoutOpen = false;
      },
    });
  }

  async function confirmOrder(invoiceId) {
    state.confirming = true;
    renderDrawer();
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const response = await fetch(`/shop/api/orders/${invoiceId}`);
        const order = response.ok ? await response.json() : null;
        if (order && order.status === "paid") {
          state.done = order;
          state.confirming = false;
          cart.clear();
          renderCart();
          return;
        }
      } catch {
        // Ask again: a lost request is not a lost payment.
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    state.confirming = false;
    state.error = "We got your payment and are still confirming it. Check back in a minute.";
    renderDrawer();
  }

  function newOrder() {
    state.done = null;
    state.error = "";
    renderCart();
    closeDrawer();
  }

  function openDrawer() {
    opener = document.activeElement;
    const drawer = $("drawer");
    drawer.hidden = false;
    $("scrim").hidden = false;
    $("main").inert = true;
    $("top").inert = true;
    requestAnimationFrame(() => drawer.classList.add("open"));
    $("cart-close").focus();
  }

  function closeDrawer() {
    const drawer = $("drawer");
    drawer.classList.remove("open");
    $("scrim").hidden = true;
    $("main").inert = false;
    $("top").inert = false;
    setTimeout(() => {
      if (!drawer.classList.contains("open")) drawer.hidden = true;
    }, 200);
    if (opener && typeof opener.focus === "function") opener.focus();
  }

  document.addEventListener("keydown", (event) => {
    const drawer = $("drawer");
    if (drawer.hidden || checkoutOpen) return; // The checkout owns the keyboard while it is open.
    if (event.key === "Escape") closeDrawer();
    if (event.key === "Tab") {
      const focusable = [...drawer.querySelectorAll("button:not([disabled])")];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) (event.preventDefault(), last.focus());
      else if (!event.shiftKey && document.activeElement === last) (event.preventDefault(), first.focus());
    }
  });

  $("cart-open").addEventListener("click", openDrawer);
  $("cart-close").addEventListener("click", closeDrawer);
  $("scrim").addEventListener("click", closeDrawer);

  async function start() {
    try {
      const response = await fetch("/shop/api/products");
      const data = await response.json();
      products = data.products;
      limits = data.limits;
      renderProducts();
    } catch {
      $("products").replaceChildren(
        el("li", { class: "empty", text: "The shop didn't load. Reload the page to try again." }),
      );
    }
    renderCart();
  }
  void start();
})();
