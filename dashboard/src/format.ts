import type { AttemptStatus, DeliveryState, Invoice, InvoiceStatus, RefundStatus } from "./types.js";

export type Tone = "success" | "neutral" | "warning" | "info" | "danger" | "muted";

export const formatDateTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "5 minutes ago", "yesterday", "in 2 hours": how long ago, or from now, in the largest unit that fits. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** `0x1234…abcd`: enough to recognise an address without filling a table cell. */
export function shorten(text: string, head = 8, tail = 6): string {
  return text.length <= head + tail + 1 ? text : `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** An amount in base units as a decimal string, exactly (no floating point): 12500000 with 6 decimals is "12.5". */
export function formatUnits(base: bigint, decimals: number): string {
  const negative = base < 0n;
  const digits = (negative ? -base : base).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** How far through a limit: 0 to 100, never more, and 0 if there is no limit. */
export function percent(used: string, limit: string): number {
  const max = BigInt(limit);
  if (max <= 0n) return 0;
  const ratio = Number((BigInt(used) * 10_000n) / max) / 100;
  return Math.min(100, Math.max(0, ratio));
}

/** The label and colour for an invoice, which also says when part or all of it has been refunded. */
export function invoiceBadge(invoice: Pick<Invoice, "status" | "amountBase" | "refundedAmountBase">): {
  label: string;
  tone: Tone;
} {
  if (invoice.status === "paid") {
    const refunded = BigInt(invoice.refundedAmountBase);
    if (refunded >= BigInt(invoice.amountBase)) return { label: "Refunded", tone: "info" };
    if (refunded > 0n) return { label: "Partially refunded", tone: "info" };
    return { label: "Paid", tone: "success" };
  }
  const labels: Record<Exclude<InvoiceStatus, "paid">, { label: string; tone: Tone }> = {
    open: { label: "Open", tone: "neutral" },
    expired: { label: "Expired", tone: "muted" },
    canceled: { label: "Canceled", tone: "muted" },
  };
  return labels[invoice.status];
}

export interface Badge {
  label: string;
  tone: Tone;
}

const CHAIN_NAMES: Record<string, string> = {
  near: "NEAR",
  base: "Base",
  arb: "Arbitrum",
  eth: "Ethereum",
  sol: "Solana",
  btc: "Bitcoin",
  tron: "Tron",
  op: "Optimism",
  pol: "Polygon",
  bsc: "BNB Chain",
  avax: "Avalanche",
};

/** A chain code as a person writes it: `near` is NEAR, `arb` is Arbitrum, and anything unknown is upper-cased. */
export const chainName = (chain: string): string => CHAIN_NAMES[chain.toLowerCase()] ?? chain.toUpperCase();

export const attemptBadge = (status: AttemptStatus): Badge =>
  (
    {
      awaiting: { label: "Waiting for payment", tone: "neutral" },
      confirming: { label: "Confirming", tone: "neutral" },
      underpaid: { label: "Underpaid", tone: "warning" },
      paid: { label: "Paid", tone: "success" },
      refunded: { label: "Returned to customer", tone: "info" },
      failed: { label: "Failed", tone: "danger" },
      superseded: { label: "Replaced", tone: "muted" },
    } satisfies Record<AttemptStatus, Badge>
  )[status];

export const refundBadge = (status: RefundStatus): Badge =>
  (
    {
      awaiting_approval: { label: "Waiting for approval", tone: "warning" },
      pending: { label: "Processing", tone: "neutral" },
      submitted: { label: "Processing", tone: "neutral" },
      succeeded: { label: "Refunded", tone: "info" },
      failed: { label: "Failed", tone: "danger" },
    } satisfies Record<RefundStatus, Badge>
  )[status];

export const deliveryBadge = (state: DeliveryState): Badge =>
  (
    {
      delivered: { label: "Delivered", tone: "success" },
      pending: { label: "Pending", tone: "neutral" },
      failed: { label: "Failed", tone: "danger" },
    } satisfies Record<DeliveryState, Badge>
  )[state];

const csvCell = (value: string) => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
};

/** Spreadsheet-safe CSV: quoted, and a leading = + - @ cannot start a formula. */
export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
