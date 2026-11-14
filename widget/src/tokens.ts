/** What /pay/tokens returns. */
export interface TokenOption {
  assetId: string;
  symbol: string;
  decimals: number;
  /** Names the token's image: the widget asks `/pay/icons/token/<icon>`. Absent when the server has none. */
  icon?: string;
}

export interface TokensPayload {
  chains: Record<string, TokenOption[]>;
  /** The chains the checkout offers. The server decides; the widget never shows others. */
  enabledChains: string[];
  /** The networks the server has an image for: the widget asks `/pay/icons/chain/<network>`. */
  chainIcons?: string[];
}

export interface TokenChoice extends TokenOption {
  /** Another token on this chain has the same symbol. */
  ambiguous: boolean;
  /** Contract hint to tell look-alikes apart, e.g. usdt.tether-token.near. */
  detail: string;
}

export interface ChainChoice {
  chain: string;
  name: string;
  /** The server has an image for this network. */
  hasIcon: boolean;
  tokens: TokenChoice[];
}

const NAMES: Record<string, string> = {
  base: "Base",
  arb: "Arbitrum",
  eth: "Ethereum",
  sol: "Solana",
  near: "NEAR",
  btc: "Bitcoin",
  tron: "Tron",
  op: "Optimism",
  pol: "Polygon",
  bsc: "BNB Chain",
  avax: "Avalanche",
};

export const chainName = (chain: string): string => NAMES[chain.toLowerCase()] ?? chain.toUpperCase();

/** PLAN section 12: popular chains first. */
const POPULAR_CHAINS = ["base", "arb", "eth", "sol", "near", "btc", "tron"];
const STABLECOINS = ["USDC", "USDT", "USDT0"];
const NATIVE: Record<string, string> = {
  eth: "ETH",
  base: "ETH",
  arb: "ETH",
  op: "ETH",
  scroll: "ETH",
  sol: "SOL",
  btc: "BTC",
  near: "wNEAR",
  tron: "TRX",
  bsc: "BNB",
  pol: "POL",
  avax: "AVAX",
};

const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/** Stablecoins first, then the chain's native coin, then everything else. */
function rank(chain: string, symbol: string): number {
  const stable = STABLECOINS.indexOf(symbol.toUpperCase());
  if (stable !== -1) return stable;
  return symbol === NATIVE[chain] ? STABLECOINS.length : STABLECOINS.length + 1;
}

/** `nep141:usdt.tether-token.near` becomes `usdt.tether-token.near`; long contracts are shortened. */
function contractHint(assetId: string): string {
  const contract = assetId.replace(/^[a-z0-9_]+:/i, "");
  return contract.length > 28 ? `${contract.slice(0, 16)}…${contract.slice(-8)}` : contract;
}

function tokensFor(chain: string, tokens: TokenOption[]): TokenChoice[] {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t.symbol.toLowerCase(), (counts.get(t.symbol.toLowerCase()) ?? 0) + 1);
  return tokens
    .map((t) => ({ ...t, ambiguous: (counts.get(t.symbol.toLowerCase()) ?? 0) > 1, detail: contractHint(t.assetId) }))
    .toSorted(
      (a, b) =>
        rank(chain, a.symbol) - rank(chain, b.symbol) ||
        compare(a.symbol, b.symbol) ||
        a.assetId.length - b.assetId.length,
    );
}

/** Chains and tokens in the order the payer should see them. Chains the server did not enable are left out. */
export function buildChoices(payload: TokensPayload): ChainChoice[] {
  return payload.enabledChains
    .filter((chain) => (payload.chains[chain]?.length ?? 0) > 0)
    .map((chain) => ({
      chain,
      name: chainName(chain),
      hasIcon: payload.chainIcons?.includes(chain) ?? false,
      tokens: tokensFor(chain, payload.chains[chain]!),
    }))
    .toSorted((a, b) => {
      const ia = POPULAR_CHAINS.indexOf(a.chain);
      const ib = POPULAR_CHAINS.indexOf(b.chain);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
      return a.name.localeCompare(b.name);
    });
}

/** Search the networks by name or id. */
export function filterChains(choices: ChainChoice[], query: string): ChainChoice[] {
  const q = query.trim().toLowerCase();
  if (!q) return choices;
  return choices.filter((c) => c.chain.includes(q) || c.name.toLowerCase().includes(q));
}

/** Search one network's tokens by symbol. */
export function filterTokens(tokens: TokenChoice[], query: string): TokenChoice[] {
  const q = query.trim().toLowerCase();
  if (!q) return tokens;
  return tokens.filter((t) => t.symbol.toLowerCase().includes(q));
}
