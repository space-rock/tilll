// The shop's browser code. It never sees the merchant secret or chooses the price:
// it asks the shop's own server to create the invoice, then opens the Tilll checkout for it.
const button = document.getElementById("buy");
const status = document.getElementById("status");

function say(text, kind) {
  status.textContent = text;
  status.className = kind ?? "";
}

button.addEventListener("click", async () => {
  say("");
  if (!window.Tilll) return say("The checkout widget did not load. Is the Tilll server running?", "bad");
  button.disabled = true;
  try {
    const res = await fetch("/api/checkout", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message ?? "Could not start checkout.");
    window.Tilll.open({
      invoiceId: data.invoiceId,
      onPaid: () => say("Order confirmed. Your beans are on the way. Thank you!", "ok"),
    });
  } catch (error) {
    say(error.message, "bad");
  } finally {
    button.disabled = false;
  }
});

// Show the webhooks Tilll has delivered to this shop's server, each already signature-verified there.
const list = document.getElementById("webhooks");
async function showWebhooks() {
  try {
    const res = await fetch("/api/webhooks");
    if (!res.ok) return;
    const { events } = await res.json();
    list.replaceChildren(
      ...events.map((e) => {
        const li = document.createElement("li");
        const type = document.createElement("b");
        type.textContent = e.type;
        li.append(type, ` received and signature verified (${e.id.slice(0, 12)}…)`);
        return li;
      }),
    );
  } catch {
    // the shop server is not reachable; try again on the next tick
  }
}
setInterval(showWebhooks, 2000);
void showWebhooks();
