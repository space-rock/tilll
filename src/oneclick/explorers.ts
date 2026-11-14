import type { TransactionDetails } from "./types.js";

/**
 * Transaction pages by 1Click chain code. The live 1Click API answers `explorerUrl: ""` for every hash (the Tidepool
 * testnet filled it in), so a payment page or dashboard row would link nowhere. When 1Click gives no link, Tilll builds one
 * for chains it knows. A chain it does not know keeps the empty link and the UI shows the bare hash.
 */
const TX_URL: Record<string, string> = {
  near: "https://nearblocks.io/txns/",
  base: "https://basescan.org/tx/",
  arb: "https://arbiscan.io/tx/",
  eth: "https://etherscan.io/tx/",
  op: "https://optimistic.etherscan.io/tx/",
  bsc: "https://bscscan.com/tx/",
  pol: "https://polygonscan.com/tx/",
  avax: "https://snowtrace.io/tx/",
  gnosis: "https://gnosisscan.io/tx/",
  sol: "https://solscan.io/tx/",
  btc: "https://mempool.space/tx/",
  tron: "https://tronscan.org/#/transaction/",
};

/** Only a plain hash is put into a URL: letters and digits, with an optional 0x. Anything else keeps the link empty. */
const HASH = /^(?:0x)?[0-9A-Za-z]{20,128}$/;

/** The chain code in a 1Click asset id: `nep141:base-0x….omft.near` is base, a bare 64-hex `nep141:` id is NEAR itself. */
export function chainOfAssetId(assetId: string | undefined | null): string | null {
  if (!assetId) return null;
  const prefixed = /^nep141:([a-z0-9]+)-/.exec(assetId);
  if (prefixed) return prefixed[1]!;
  if (/^nep141:[0-9a-f]{64}$/.test(assetId) || /^nep141:[a-z0-9._-]+\.near$/.test(assetId)) return "near";
  return null;
}

/** Keeps a link 1Click gave (http or https only) and fills an empty one from the chain. */
export function withExplorerLinks(links: TransactionDetails[], chain: string | null): TransactionDetails[] {
  const base = chain ? TX_URL[chain] : undefined;
  return links.map((link) => {
    if (/^https?:\/\//.test(link.explorerUrl)) return link;
    if (!base || !HASH.test(link.hash)) return link;
    return { ...link, explorerUrl: base + link.hash };
  });
}
