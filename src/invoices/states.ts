import type { SwapStatus } from "../oneclick/types.js";

export type InvoiceStatus = "open" | "paid" | "expired" | "canceled";

export type AttemptStatus = "awaiting" | "confirming" | "underpaid" | "paid" | "refunded" | "failed" | "superseded";

const TERMINAL: ReadonlySet<AttemptStatus> = new Set(["paid", "refunded", "failed"]);

/** Terminal attempts are never polled again and never change. */
export const isTerminalAttempt = (status: AttemptStatus): boolean => TERMINAL.has(status);

/**
 * PLAN section 8 mapping from the raw 1Click status to an attempt status.
 * A superseded attempt stays superseded until money actually shows up on it.
 */
export function nextAttemptStatus(current: AttemptStatus, swap: SwapStatus): AttemptStatus {
  if (isTerminalAttempt(current)) return current;
  switch (swap) {
    case "PENDING_DEPOSIT":
      return current === "superseded" ? "superseded" : "awaiting";
    case "KNOWN_DEPOSIT_TX":
    case "PROCESSING":
      return "confirming";
    case "INCOMPLETE_DEPOSIT":
      return "underpaid";
    case "SUCCESS":
      return "paid";
    case "REFUNDED":
      return "refunded";
    case "FAILED":
      return "failed";
  }
}
