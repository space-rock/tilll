import { useCallback, useState } from "react";
import { ApiError, request } from "../api.js";
import type { PreparedRefund, Refund } from "../types.js";
import { useWallet } from "../wallet.js";
import { useToast } from "./ui/toast.js";

export type ApprovalStep = "idle" | "preparing" | "signing" | "sending";

/** Why an approval stopped, and what the merchant can do about it. */
export interface ApprovalProblem {
  message: string;
  /** Set when the wallet's key has to be registered on the verifier first. */
  registerKey?: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Try again.");

/**
 * Approving a refund with the connected wallet, in three steps: the server prepares and checks the intent, the wallet
 * signs it, and the signature goes back. Each failure comes back as a plain sentence, with the one action that helps.
 */
export function useRefundApproval() {
  const wallet = useWallet();
  const toast = useToast();
  const [step, setStep] = useState<ApprovalStep>("idle");
  const [problem, setProblem] = useState<ApprovalProblem | undefined>(undefined);

  const approve = useCallback(
    async (refundId: string): Promise<Refund | undefined> => {
      setProblem(undefined);
      if (wallet.status !== "connected") {
        setProblem({ message: "Connect your wallet to approve this refund." });
        return undefined;
      }
      if (!wallet.matches) {
        setProblem({
          message: `Switch to ${wallet.expectedAccount ?? "the settlement account"} in your wallet. It's signed in as ${wallet.accountId}, and only the settlement account can approve refunds.`,
        });
        return undefined;
      }

      let prepared: PreparedRefund;
      setStep("preparing");
      try {
        prepared = await request<PreparedRefund>("POST", `/v1/refunds/${refundId}/prepare`, {});
      } catch (e) {
        setStep("idle");
        setProblem({ message: e instanceof ApiError ? e.message : message(e) });
        return undefined;
      }

      let signed;
      setStep("signing");
      try {
        signed = await wallet.signMessage(prepared.payload);
      } catch (e) {
        setStep("idle");
        setProblem({ message: `Your wallet didn't approve the refund. ${message(e)}` });
        return undefined;
      }

      setStep("sending");
      try {
        const done = await request<{ refund: Refund }>("POST", `/v1/refunds/${refundId}/submit`, {
          publicKey: signed.publicKey,
          signature: signed.signature,
        });
        setStep("idle");
        return done.refund;
      } catch (e) {
        setStep("idle");
        if (e instanceof ApiError && e.code === "key_not_registered") {
          setProblem({
            message: `NEAR Intents doesn't recognize this wallet's key for ${wallet.expectedAccount} yet. Register the key once, then approve the refund again.`,
            registerKey: signed.publicKey,
          });
        } else {
          setProblem({
            message:
              e instanceof ApiError && e.code === "intent_expired"
                ? "The approval expired because it took too long. Approve the refund again."
                : e instanceof ApiError
                  ? e.message
                  : message(e),
          });
        }
        return undefined;
      }
    },
    [wallet],
  );

  const registerKey = useCallback(
    async (publicKey: string) => {
      try {
        await wallet.registerKey(publicKey);
        setProblem(undefined);
        toast({ title: "Key registered", description: "You can approve the refund now.", tone: "success" });
      } catch (e) {
        setProblem({ message: `We couldn't register the key. ${message(e)}`, registerKey: publicKey });
      }
    },
    [wallet, toast],
  );

  return { approve, registerKey, step, busy: step !== "idle", problem, clearProblem: () => setProblem(undefined) };
}

/** What the button says while an approval runs. */
export const stepLabel: Record<ApprovalStep, string> = {
  idle: "Approve in wallet",
  preparing: "Preparing the refund…",
  signing: "Waiting for your wallet…",
  sending: "Sending the refund…",
};
