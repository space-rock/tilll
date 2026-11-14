import { Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, request } from "../api.js";
import { chainName, refundBadge } from "../format.js";
import type { InvoiceDetail, Refund, RefundPreview } from "../types.js";
import { useWallet } from "../wallet.js";
import { ErrorNote, Mono, StatusBadge, TxLinks } from "./Bits.js";
import { Button } from "./ui/button.js";
import { Dialog } from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Stepper } from "./ui/stepper.js";
import { useToast } from "./ui/toast.js";
import { stepLabel, useRefundApproval } from "./useRefundApproval.js";

type PreviewState =
  | { kind: "loading" }
  | { kind: "ok"; preview: RefundPreview; forAmount: string }
  | { kind: "error"; message: string };

const PREVIEW_DELAY_MS = 400;

const STEPS = [{ label: "Review" }, { label: "Approve" }, { label: "Send" }];

/**
 * Amount, then a dry quote of what the customer would receive, then the merchant's wallet approves it, then the refund's
 * live status. The idempotency key is made once when the dialog opens, so pressing Approve twice (or retrying after a
 * lost answer) can never ask for two refunds, and a refund that is waiting for approval is approved again, not repeated.
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
  const wallet = useWallet();
  const approval = useRefundApproval();
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
    approval.clearProblem();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a newly opened dialog starts over
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
            setPreview({
              kind: "error",
              message: e instanceof ApiError ? e.message : "Something went wrong. Try again.",
            });
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

  // After the refund is sent: follow it until it ends.
  useEffect(() => {
    if (!refund || refund.status === "awaiting_approval" || refund.status === "succeeded" || refund.status === "failed")
      return;
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
                    title: "Refund completed",
                    description: `${current.amount} ${detail.invoice.asset.symbol} was returned to your customer.`,
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

  /** Ask for the refund once, then have the wallet approve it. A refund that already waits is only approved again. */
  const approve = async () => {
    setError(undefined);
    let waiting = refund;
    if (!waiting) {
      setSubmitting(true);
      try {
        const result = await request<{ refund: Refund }>("POST", `/v1/invoices/${invoiceId}/refunds`, {
          amount: amount.trim(),
          idempotencyKey: key.current,
        });
        waiting = result.refund;
        setRefund(waiting);
        onChanged();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
        return;
      } finally {
        setSubmitting(false);
      }
    }
    const sent = await approval.approve(waiting.id);
    if (sent) {
      setRefund(sent);
      onChanged();
    }
  };

  const connect = () => {
    void wallet.connect().catch((e: unknown) => {
      toast({
        title: "Wallet not connected",
        description: e instanceof Error ? e.message : "Something went wrong. Try again.",
        tone: "danger",
      });
    });
  };

  const current = preview.kind === "ok" && preview.forAmount === amount.trim();
  const ended = refund?.status === "succeeded" || refund?.status === "failed";
  const sent = refund !== undefined && refund.status !== "awaiting_approval";
  const connected = wallet.status === "connected";
  const stepIndex = ended ? STEPS.length : sent ? 2 : refund || approval.busy ? 1 : 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Refund"
      description="Your wallet approves the refund. Your customer is paid back on the network and to the address they paid from."
    >
      <Stepper steps={STEPS} current={stepIndex} failed={refund?.status === "failed"} />

      {!sent && (
        <>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Amount to refund
            <Input
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="Loading the refundable amount…"
              aria-describedby="refund-preview"
              disabled={refund !== undefined}
            />
          </label>

          <div
            id="refund-preview"
            className="flex min-h-24 flex-col gap-2 rounded-lg bg-muted p-3.5 text-sm"
            aria-live="polite"
          >
            {preview.kind === "loading" && (
              <p className="text-muted-foreground">Working out what your customer will receive…</p>
            )}
            {preview.kind === "error" && <ErrorNote message={preview.message} />}
            {preview.kind === "ok" && (
              <>
                <p>
                  The customer receives about{" "}
                  <strong className="num">
                    {preview.preview.estimate.amountOutFormatted} {preview.preview.destination.symbol}
                  </strong>{" "}
                  on {chainName(preview.preview.destination.chain)}.
                </p>
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  To <Mono text={preview.preview.destination.address} />
                </p>
                <p className="text-xs text-muted-foreground">
                  Usually takes about {preview.preview.estimate.timeEstimate} seconds.
                </p>
                <p className="text-xs text-muted-foreground">{preview.preview.note}</p>
              </>
            )}
          </div>

          {!connected && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Wallet aria-hidden="true" className="h-4 w-4 shrink-0" />
              Connect your wallet to approve this refund.
            </p>
          )}
          {connected && !wallet.matches && (
            <p className="text-sm text-warning">
              You're connected as {wallet.accountId}. Refunds are approved by {wallet.expectedAccount}.
            </p>
          )}
          {error && <ErrorNote message={error} />}
          {approval.problem && (
            <ErrorNote
              message={approval.problem.message}
              action={
                approval.problem.registerKey ? (
                  <div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void approval.registerKey(approval.problem!.registerKey!)}
                    >
                      Register key
                    </Button>
                  </div>
                ) : undefined
              }
            />
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {refund ? "Close" : "Cancel"}
            </Button>
            {connected ? (
              <Button
                onClick={() => void approve()}
                disabled={(!refund && !current) || !wallet.matches}
                loading={submitting || approval.busy}
              >
                {submitting ? "Creating the refund…" : approval.busy ? stepLabel[approval.step] : "Approve in wallet"}
              </Button>
            ) : (
              <Button onClick={connect} loading={wallet.status === "connecting" || wallet.status === "restoring"}>
                Connect wallet to approve
              </Button>
            )}
          </div>
          {refund && (
            <p className="text-xs text-muted-foreground">
              The refund is saved and waits for your approval. You can close this window and approve it later from the
              Refunds page.
            </p>
          )}
        </>
      )}

      {sent && (
        <>
          <div className="flex flex-col gap-2 rounded-lg bg-muted p-3.5 text-sm" aria-live="polite">
            <p className="flex items-center gap-2">
              Refund of <strong className="num">{refund.amount}</strong>{" "}
              <StatusBadge badge={refundBadge(refund.status)} />
            </p>
            {!ended && (
              <p className="text-xs text-muted-foreground">
                This can take a minute. You can close this window and the refund will continue.
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
