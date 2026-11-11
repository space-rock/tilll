import { ApiError } from "../errors.js";
import { OneClickError } from "./client.js";

/** Turn a 1Click failure into the error the payer or merchant should see. Anything else is a bug and passes through. */
export function mapQuoteError(e: unknown): unknown {
  if (!(e instanceof OneClickError)) return e;
  const body = e.body as { message?: unknown } | undefined;
  const detail = typeof body?.message === "string" ? body.message : e.message;
  if (e.status === 400 && /refundTo/i.test(detail)) return new ApiError(400, "invalid_refund_address", detail);
  if (e.status === 400 && /pair is not available/i.test(detail)) return new ApiError(422, "pair_unavailable", detail);
  if (e.status === 400) return new ApiError(422, "quote_rejected", detail);
  if (e.status === 0) return new ApiError(503, "upstream_unavailable", detail);
  return new ApiError(502, "upstream_error", detail);
}
