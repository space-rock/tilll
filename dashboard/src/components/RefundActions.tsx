import { useState } from "react";
import { ApiError, request } from "../api.js";
import type { Refund } from "../types.js";
import { useWallet } from "../wallet.js";
import { ErrorNote } from "./Bits.js";
import { Button } from "./ui/button.js";
import { useToast } from "./ui/toast.js";
import { stepLabel, useRefundApproval } from "./useRefundApproval.js";

/**
 * Approve or cancel a refund that is waiting for the merchant's wallet. It shows nothing for any other refund. When no
 * wallet is connected the button connects one, and the merchant presses Approve again.
 */
export function RefundActions({ refund, onChanged }: { refund: Refund; onChanged: () => void }) {
  const wallet = useWallet();
  const toast = useToast();
  const approval = useRefundApproval();
  const [canceling, setCanceling] = useState(false);

  if (refund.status !== "awaiting_approval") return null;

  const approve = async () => {
    const sent = await approval.approve(refund.id);
    if (sent) {
      toast({ title: "Refund approved", description: "It's on its way to your customer.", tone: "success" });
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

  const cancel = async () => {
    setCanceling(true);
    try {
      await request("POST", `/v1/refunds/${refund.id}/cancel`, {});
      toast({ title: "Refund canceled", description: "The amount can be refunded again.", tone: "neutral" });
      onChanged();
    } catch (e) {
      toast({
        title: "We couldn't cancel the refund",
        description: e instanceof ApiError ? e.message : "Something went wrong. Try again.",
        tone: "danger",
      });
    } finally {
      setCanceling(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {wallet.status === "connected" ? (
          <Button
            size="sm"
            onClick={() => void approve()}
            loading={approval.busy}
            disabled={!wallet.matches || canceling}
            aria-label={`Approve refund ${refund.id}`}
          >
            {approval.busy ? stepLabel[approval.step] : "Approve in wallet"}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={connect}
            loading={wallet.status === "connecting" || wallet.status === "restoring"}
            aria-label={`Connect wallet to approve refund ${refund.id}`}
          >
            Connect wallet to approve
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => void cancel()}
          loading={canceling}
          disabled={approval.busy}
          aria-label={`Cancel refund ${refund.id}`}
        >
          Cancel refund
        </Button>
      </div>
      {wallet.status === "connected" && !wallet.matches && (
        <p className="text-xs text-warning">
          You're connected as {wallet.accountId}. Refunds are approved by {wallet.expectedAccount}.
        </p>
      )}
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
    </div>
  );
}
