import type { z } from "zod";
import { ApiError } from "../errors.js";
import type { IconService } from "../icons.js";
import type { TokenCache } from "../oneclick/tokens.js";
import { STRICT_CHAINS } from "../validate/addresses.js";

/** Validate untrusted input. Failures become a 400 that names every bad field. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "body"}: ${i.message}`)
    .join("; ");
  throw new ApiError(400, "invalid_request", detail);
}

/**
 * The origin tokens 1Click can take, grouped by chain. `enabledChains` are the ones the checkout offers: those with
 * a strict address check plus EXTRA_CHAINS, and only if 1Click actually lists tokens for them.
 */
export async function chainsPayload(tokens: TokenCache, extraChains: string[] = [], icons?: IconService) {
  const grouped = await tokens.byChain();
  const chains: Record<string, { assetId: string; symbol: string; decimals: number; icon?: string }[]> = {};
  for (const [chain, list] of Object.entries(grouped)) {
    chains[chain] = list.map((t) => ({
      assetId: t.assetId,
      symbol: t.symbol,
      decimals: t.decimals,
      // The picture's name: the widget asks `/pay/icons/token/<name>`. Tokens with no picture carry none.
      ...(icons && icons.iconNameOf(t) ? { icon: icons.iconNameOf(t)! } : {}),
    }));
  }
  const enabledChains = [...new Set([...STRICT_CHAINS, ...extraChains.map((c) => c.toLowerCase())])].filter(
    (chain) => chain in chains,
  );
  return {
    chains,
    enabledChains,
    ...(icons ? { chainIcons: enabledChains.filter((chain) => icons.chainsWithIcon.includes(chain)) } : {}),
  };
}
