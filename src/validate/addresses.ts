/**
 * Refund-address format checks (PLAN section 12), shared by the server and the checkout widget bundle, so this
 * file must stay free of Node APIs. These are format checks only: they catch typos and wrong-chain addresses
 * early. 1Click is the final authority and rejects what it does not accept.
 */

export type AddressCheck = { ok: true; strict: boolean } | { ok: false; reason: string };

/** Every EVM chain 1Click lists that takes a 0x address. */
const EVM_CHAINS = [
  "eth",
  "base",
  "arb",
  "op",
  "pol",
  "bsc",
  "avax",
  "gnosis",
  "bera",
  "monad",
  "xlayer",
  "plasma",
  "scroll",
  "abs",
];

const EVM = /^0x[a-fA-F0-9]{40}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NEAR_NAMED = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const BTC_BECH32 = /^bc1[a-z0-9]{25,62}$/;
const BTC_BASE58 = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
const TRON = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/** Longest address any check looks at. Keeps regex work bounded on hostile input. */
const MAX_LENGTH = 128;

type Rule = { test: (address: string) => boolean; hint: string };

const RULES = new Map<string, Rule>([
  ...EVM_CHAINS.map((chain): [string, Rule] => [
    chain,
    {
      test: (a) => EVM.test(a),
      hint: "That doesn't look like a valid address. It should start with 0x and be 42 characters long.",
    },
  ]),
  [
    "sol",
    {
      test: (a) => SOLANA.test(a),
      hint: "That doesn't look like a Solana address. It should be 32 to 44 letters and numbers, without 0, O, I or l.",
    },
  ],
  [
    "near",
    {
      test: (a) => a.length >= 2 && a.length <= 64 && NEAR_NAMED.test(a),
      hint: "That doesn't look like a NEAR account. Use a name like alice.near, or a 64-character hex address.",
    },
  ],
  [
    "btc",
    {
      test: (a) => BTC_BECH32.test(a) || BTC_BASE58.test(a),
      hint: "That doesn't look like a Bitcoin address. It should start with bc1, 1 or 3. Testnet addresses aren't supported.",
    },
  ],
  [
    "tron",
    {
      test: (a) => TRON.test(a),
      hint: "That doesn't look like a Tron address. It should start with T and be 34 characters long.",
    },
  ],
]);

/** Chains with a strict format check. The checkout widget offers these by default. */
export const STRICT_CHAINS: readonly string[] = [...RULES.keys()];

export const hasStrictValidation = (chain: string): boolean => RULES.has(chain.toLowerCase());

/** Check `address` for `chain`. Chains without a strict rule only need a non-empty address without whitespace. */
export function validateAddress(chain: string, address: string): AddressCheck {
  if (address.length === 0) return { ok: false, reason: "Enter the address your funds should be returned to." };
  if (/\s/.test(address)) return { ok: false, reason: "The address can't contain spaces or line breaks." };
  if (address.length > MAX_LENGTH) return { ok: false, reason: "That address is too long." };

  const rule = RULES.get(chain.toLowerCase());
  if (!rule) return { ok: true, strict: false };
  return rule.test(address) ? { ok: true, strict: true } : { ok: false, reason: rule.hint };
}
