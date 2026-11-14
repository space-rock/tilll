import { STRICT_CHAINS } from "../../src/validate/addresses.js";
import { TilllApiError } from "../../widget/src/api.js";
import type { TokensPayload } from "../../widget/src/tokens.js";
import type { AttemptStatus, InvoiceStatus, PublicAttempt, PublicInvoice } from "../../widget/src/types.js";
import { TOKENS } from "./oneclickData.js";

export const EVM = "0x1111111111111111111111111111111111111111";
export const SOL_USDC = TOKENS.find((t) => t.blockchain === "sol" && t.symbol === "USDC")!.assetId;

export const payload: TokensPayload = (() => {
  const chains: TokensPayload["chains"] = {};
  for (const t of TOKENS)
    (chains[t.blockchain] ??= []).push({ assetId: t.assetId, symbol: t.symbol, decimals: t.decimals });
  return { chains, enabledChains: STRICT_CHAINS.filter((c) => c in chains) };
})();

export const invoice = (status: InvoiceStatus = "open"): PublicInvoice => ({
  id: "inv_1",
  status,
  amount: "5",
  asset: { id: "nep141:usdc", symbol: "USDC", decimals: 6 },
  description: "Coffee",
  expiresAt: "2026-11-05T11:00:00.000Z",
});

let counter = 0;
export const attempt = (
  status: AttemptStatus = "awaiting",
  invoiceStatus: InvoiceStatus = "open",
  id = `att_${++counter}`,
): PublicAttempt => ({
  id,
  invoiceId: "inv_1",
  status,
  invoiceStatus,
  depositAddress: `0xDEPOSIT${id}`,
  depositMemo: null,
  amountIn: "5.051529",
  symbol: "USDC",
  chain: "base",
  deadline: "2026-11-05T10:30:00.000Z",
  timeEstimate: 35,
  txLinks: [],
});

export const apiError = (status: number, code: string, message = code) => new TilllApiError(status, code, message);
