import { useEffect, useState, type FormEvent } from "react";
import { ApiError, request } from "../api.js";
import type { Invoice } from "../types.js";
import { ExternalLink } from "lucide-react";
import { CopyButton, ErrorNote } from "./Bits.js";
import { Button } from "./ui/button.js";
import { Dialog } from "./ui/dialog.js";
import { navigate } from "../router.js";
import { Input } from "./ui/input.js";

/** The "Create invoice" button's dialog: a quick way to make an invoice and get its payment link. */
export function CreateInvoiceDialog({
  open,
  symbol,
  onClose,
  onCreated,
}: {
  open: boolean;
  symbol: string;
  onClose: () => void;
  onCreated: (invoice: Invoice) => void;
}) {
  const [amount, setAmount] = useState("5.00");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Invoice | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    setAmount("5.00");
    setDescription("");
    setError(undefined);
    setCreated(undefined);
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const invoice = await request<Invoice>("POST", "/v1/invoices", {
        amount: amount.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setCreated(invoice);
      onCreated(invoice);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create invoice"
      description="Create an invoice, then open its payment link to try the checkout."
    >
      {created ? (
        <>
          <div className="flex flex-col gap-3 rounded-lg bg-muted p-3.5 text-sm">
            <p>
              Created an invoice for{" "}
              <strong className="num">
                {created.amount} {created.asset.symbol}
              </strong>
              .
            </p>
            {created.payUrl && (
              <p className="flex items-center gap-1">
                <a
                  href={created.payUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 break-all underline underline-offset-2 hover:text-muted-foreground"
                >
                  {created.payUrl}
                  <ExternalLink aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                </a>
                <CopyButton text={created.payUrl} label="Copy payment link" />
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                onClose();
                navigate(`/invoices/${created.id}`);
              }}
            >
              View invoice
            </Button>
            <Button onClick={onClose}>Done</Button>
          </div>
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Amount ({symbol})
            <Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} required />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Description (optional)
            <Input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} />
          </label>
          {error && <ErrorNote message={error} />}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              {busy ? "Creating…" : "Create invoice"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
