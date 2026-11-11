import { useEffect, useRef, useState } from "react";
import { ApiError, request } from "../api.js";
import { refundBadge } from "../format.js";
import type { InvoiceDetail, Refund, RefundPreview } from "../types.js";
import { ErrorNote, Mono, StatusBadge, TxLinks } from "./Bits.js";
import { Button } from "./ui/button.js";
import { Dialog } from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { useToast } from "./ui/toast.js";

type PreviewState =
  | { kind: "loading" }
  | { kind: "ok"; preview: RefundPreview; forAmount: string }
  | { kind: "error"; message: string };

const PREVIEW_DELAY_MS = 400;

/**
 * Amount, then a dry quote of what the customer would receive, then confirm, then the refund's live status. The
 * idempotency key is made once when the dialog opens, so pressing Confirm twice (or retrying after a lost answer)
 * can never refund twice.
 */
export function RefundDialog({
  open,
  invoiceId,
  onClose,
  onChanged,
  pollMs = 3000,
}: {
  open: boolean;
  invoiceId: string;
  onClose: () => void;
  /** The refund changed something worth reloading the page for. */
  onChanged: () => void;
  pollMs?: number;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [preview, setPreview] = useState<PreviewState>({ kind: "loading" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [refund, setRefund] = useState<Refund | undefined>(undefined);
  const key = useRef("");
  const firstPreview = useRef(true);
  /** The amount the first preview filled in; its quote is already on screen, so the next effect run skips asking again. */
  const quoted = useRef<string | null>(null);

  // A fresh dialog: new key, nothing typed, ask what the whole remaining amount would do.
  useEffect(() => {
    if (!open) return;
    key.current = crypto.randomUUID();
    firstPreview.current = true;
    quoted.current = null;
    setAmount("");
    setError(undefined);
    setRefund(undefined);
    setSubmitting(false);
    setPreview({ kind: "loading" });
  }, [open]);

  // The preview follows the amount, a moment after typing stops. The first one (no amount) fills the field.
  useEffect(() => {
    if (!open || refund) return;
    if (quoted.current !== null && quoted.current === amount.trim()) {
      quoted.current = null;
      return;
    }
    const first = firstPreview.current;
    let cancelled = false;
    setPreview({ kind: "loading" });
    const timer = setTimeout(
      () => {
        request<RefundPreview>(
          "POST",
          `/v1/invoices/${invoiceId}/refunds/preview`,
          amount.trim() === "" ? {} : { amount: amount.trim() },
        ).then(
          (result) => {
            if (cancelled) return;
            if (first) {
              firstPreview.current = false;
              quoted.current = result.amount;
              setPreview({ kind: "ok", preview: result, forAmount: result.amount });
              setAmount(result.amount);
              return;
            }
            setPreview({ kind: "ok", preview: result, forAmount: amount.trim() });
          },
          (e: unknown) => {
            if (cancelled) return;
            firstPreview.current = false;
            setPreview({ kind: "error", message: e instanceof ApiError ? e.message : String(e) });
          },
        );
      },
      first ? 0 : PREVIEW_DELAY_MS,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, invoiceId, amount, refund]);

  // After confirming: follow the refund until it ends.
  useEffect(() => {
    if (!refund || refund.status === "succeeded" || refund.status === "failed") return;
    let cancelled = false;
    const timer = setInterval(() => {
      request<InvoiceDetail>("GET", `/v1/invoices/${invoiceId}`).then(
        (detail) => {
          const current = detail.refunds.find((r) => r.id === refund.id);
          if (cancelled || !current) return;
          setRefund(current);
          if (current.status === "succeeded" || current.status === "failed") {
            toast(
              current.status === "succeeded"
                ? {
                    title: "Refund sent",
                    description: `${current.amount} ${detail.invoice.asset.symbol} is on its way back to the customer.`,
                    tone: "success",
                  }
                : { title: "Refund failed", description: current.error ?? undefined, tone: "danger" },
            );
            onChanged();
          }
        },
        () => undefined,
      );
    }, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refund, invoiceId, pollMs, toast, onChanged]);

  const confirm = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await request<{ refund: Refund }>("POST", `/v1/invoices/${invoiceId}/refunds`, {
        amount: amount.trim(),
        idempotencyKey: key.current,
      });
      setRefund(result.refund);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const current = preview.kind === "ok" && preview.forAmount === amount.trim();
  const ended = refund?.status === "succeeded" || refund?.status === "failed";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Refund this payment"
      description="The customer is paid back to the address and chain they paid from."
    >
      {!refund && (
        <>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Amount to refund
            <Input
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="Loading the refundable amount…"
              aria-describedby="refund-preview"
            />
          </label>

          <div
            id="refund-preview"
            className="flex min-h-24 flex-col gap-2 rounded-md bg-muted p-3 text-sm"
            aria-live="polite"
          >
            {preview.kind === "loading" && <p className="text-muted-foreground">Getting a quote…</p>}
            {preview.kind === "error" && <ErrorNote message={preview.message} />}
            {preview.kind === "ok" && (
              <>
                <p>
                  Customer receives about{" "}
                  <strong>
                    {preview.preview.estimate.amountOutFormatted} {preview.preview.destination.symbol}
                  </strong>{" "}
                  on {preview.preview.destination.chain}
                </p>
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  To <Mono text={preview.preview.destination.address} />
                </p>
                <p className="text-xs text-muted-foreground">
                  Route fee: {preview.preview.estimate.withdrawFee ?? "none quoted"} · about{" "}
                  {preview.preview.estimate.timeEstimate}s
                </p>
                <p className="text-xs text-muted-foreground">{preview.preview.note}</p>
              </>
            )}
          </div>
          {error && <ErrorNote message={error} />}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void confirm()} disabled={!current || submitting}>
              {submitting ? "Sending…" : "Confirm refund"}
            </Button>
          </div>
        </>
      )}

      {refund && (
        <>
          <div className="flex flex-col gap-2 rounded-md bg-muted p-3 text-sm" aria-live="polite">
            <p className="flex items-center gap-2">
              Refund of <strong>{refund.amount}</strong> <StatusBadge badge={refundBadge(refund.status)} />
            </p>
            {!ended && (
              <p className="text-xs text-muted-foreground">
                This can take a minute. You can close this window; the refund continues.
              </p>
            )}
            {refund.error && <ErrorNote message={refund.error} />}
            <TxLinks links={refund.txLinks} />
          </div>
          <div className="flex justify-end">
            <Button variant="outline" onClick={onClose}>
              {ended ? "Done" : "Close"}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
