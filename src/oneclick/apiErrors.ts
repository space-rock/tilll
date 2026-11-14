import { ApiError } from "../errors.js";
import { OneClickError } from "./client.js";

/** Turn a 1Click failure into the error the payer or merchant should see. Anything else is a bug and passes through. */
export function mapQuoteError(e: unknown): unknown {
  if (!(e instanceof OneClickError)) return e;
  const body = e.body as { message?: unknown } | undefined;
  const detail =
    typeof body?.message === "string" ? body.message : e.message.replace(/^1Click \w+ \S+ failed( \(\d+\))?: /, "");
  if (e.status === 400 && /refundTo/i.test(detail)) {
    return new ApiError(
      400,
      "invalid_refund_address",
      "That refund address isn't valid on this network. Check it and try again.",
    );
  }
  if (e.status === 400 && /pair is not available/i.test(detail)) {
    return new ApiError(
      422,
      "pair_unavailable",
      "This token can't be used for this payment right now. Choose another token.",
    );
  }
  // The reason (for example an amount below the minimum) is worth showing, so it follows our own sentence.
  if (e.status === 400) {
    return new ApiError(422, "quote_rejected", `We couldn't create this payment. ${detail.replace(/\.?$/, ".")}`);
  }
  if (e.status === 0) {
    return new ApiError(503, "upstream_unavailable", "We couldn't reach NEAR Intents. Try again in a moment.");
  }
  return new ApiError(502, "upstream_error", "NEAR Intents ran into a problem. Try again in a moment.");
}
