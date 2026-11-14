import type { Token } from "./types.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** SETTLEMENT_ASSET_ID is not a token 1Click supports. Thrown at startup so a typo never reaches a payer. */
export class SettlementAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementAssetError";
  }
}

export interface TokenCacheOptions {
  client: { tokens(): Promise<Token[]> };
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
  ttlMs?: number;
}

/** Cached view of GET /v0/tokens. Refreshes after the TTL; on a failed refresh it keeps serving the stale list. */
export function createTokenCache(options: TokenCacheOptions) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  let tokens: Token[] | undefined;
  let fetchedAt = 0;
  let inFlight: Promise<Token[]> | undefined;
  /** Whether the last fetch worked, for the dashboard's connection status. */
  let lastFetchOk = true;

  async function refresh(): Promise<Token[]> {
    try {
      const fresh = await options.client.tokens();
      tokens = fresh;
      fetchedAt = now();
      lastFetchOk = true;
      return fresh;
    } catch (err) {
      lastFetchOk = false;
      if (tokens) return tokens;
      throw err;
    } finally {
      inFlight = undefined;
    }
  }

  async function get(): Promise<Token[]> {
    if (tokens && now() - fetchedAt < ttlMs) return tokens;
    inFlight ??= refresh();
    return inFlight;
  }

  return {
    get,

    /** Whether 1Click answered the last time the list was fetched (it is refetched every 10 minutes). */
    async health(): Promise<{ reachable: boolean }> {
      try {
        await get();
      } catch {
        // reported below
      }
      return { reachable: lastFetchOk };
    },

    async findAsset(assetId: string): Promise<Token | undefined> {
      return (await get()).find((t) => t.assetId === assetId);
    },

    /** All tokens on `chain` with `symbol` (both case-insensitive). More than one means the route is ambiguous. */
    async find(chain: string, symbol: string): Promise<Token[]> {
      const c = chain.toLowerCase();
      const sym = symbol.toLowerCase();
      return (await get()).filter((t) => t.blockchain.toLowerCase() === c && t.symbol.toLowerCase() === sym);
    },

    async byChain(): Promise<Record<string, Token[]>> {
      const grouped: Record<string, Token[]> = {};
      for (const t of await get()) (grouped[t.blockchain] ??= []).push(t);
      return grouped;
    },

    /** Returns the settlement token, or throws SettlementAssetError naming USDC on NEAR as the likely fix. */
    async resolveSettlementAsset(assetId: string): Promise<Token> {
      const all = await get();
      const found = all.find((t) => t.assetId === assetId);
      if (found) return found;
      const suggestions = all.filter((t) => t.blockchain === "near" && t.symbol === "USDC").map((t) => t.assetId);
      throw new SettlementAssetError(
        `SETTLEMENT_ASSET_ID "${assetId}" is not in the 1Click token list (/v0/tokens).` +
          (suggestions.length ? ` USDC on NEAR is: ${suggestions.join(", ")}` : ""),
      );
    },
  };
}

export type TokenCache = ReturnType<typeof createTokenCache>;
