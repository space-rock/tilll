const pad = (n: number) => String(n).padStart(2, "0");

/** `29:59` under an hour, `2h 05m` under a day, `1d 2h` beyond. A partial second counts as a whole one. */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "00:00";
  const total = Math.ceil(ms / 1000);
  if (total < 3600) return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
  const hours = Math.floor(total / 3600);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return `${hours}h ${pad(Math.floor((total % 3600) / 60))}m`;
}

/**
 * How big to draw an amount. A token with many decimals (0.00000000000000001262875 wNEAR) is too wide for the card at
 * full size, so a long amount is drawn smaller. Anything still too wide wraps (see `.amount` in styles.ts).
 */
export function amountSize(text: string): "" | "long" | "longer" {
  if (text.length <= 18) return "";
  return text.length <= 26 ? "long" : "longer";
}

/** `0x111111…111111`: enough to recognise an address without showing all of it. */
export function shorten(text: string, head = 8, tail = 6): string {
  return text.length <= head + tail + 1 ? text : `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** A link label for an explorer URL: its host without `www.`. */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "explorer";
  }
}
