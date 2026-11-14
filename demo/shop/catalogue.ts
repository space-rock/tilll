import { z } from "zod";
import { ApiError } from "../../src/errors.js";

/**
 * The demo shop's catalogue. The server prices every cart from these entries and ignores any price a browser sends,
 * which is the first rule of a safe integration (see "Integration security" in the README). Prices are whole cents of
 * the settlement asset (USDC by default), so the arithmetic is integer arithmetic and never touches a float.
 */
export interface Product {
  id: string;
  name: string;
  blurb: string;
  cents: number;
  /** Which small drawing the page uses. The page owns the drawings, so nothing is fetched from anywhere. */
  glyph: "cup" | "latte" | "croissant" | "beans";
}

export const PRODUCTS: readonly Product[] = [
  { id: "espresso", name: "Espresso", blurb: "One shot, no fuss", cents: 25, glyph: "cup" },
  { id: "cortado", name: "Cortado", blurb: "Espresso cut with warm milk", cents: 25, glyph: "cup" },
  { id: "flat-white", name: "Flat white", blurb: "Velvety milk, double shot", cents: 25, glyph: "latte" },
  { id: "cappuccino", name: "Cappuccino", blurb: "Foam on top, as it should be", cents: 50, glyph: "latte" },
  { id: "croissant", name: "Croissant", blurb: "Butter, baked this morning", cents: 50, glyph: "croissant" },
  { id: "beans", name: "Bean sample", blurb: "30 g of single-origin beans", cents: 50, glyph: "beans" },
];

/** The most of one product in a cart, and the most a cart may cost. A demo needs neither to be large. */
export const MAX_QTY = 5;
export const MAX_TOTAL_CENTS = 300;

const cartBody = z
  .object({
    items: z
      .array(
        z
          .object({ id: z.string().min(1).max(40), qty: z.number().int().min(1).max(MAX_QTY) })
          // A line holds a product and a count. A price, a name or anything else from the browser is refused, not ignored.
          .strict(),
      )
      .min(1)
      .max(PRODUCTS.length),
  })
  .strict();

export interface PricedCart {
  lines: { product: Product; qty: number }[];
  totalCents: number;
  /** The invoice amount: display units of the settlement asset, like "0.75". */
  amount: string;
  /** What the merchant sees on the invoice: "2 x Espresso, 1 x Croissant". */
  description: string;
}

/** Cents as the decimal string an invoice takes: 75 is "0.75", 300 is "3.00". */
export const centsToAmount = (cents: number): string =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

const invalid = (message: string) => new ApiError(400, "invalid_cart", message);

/** Price a cart sent by a browser. Throws a 400 for anything that is not a plain list of known products and counts. */
export function priceCart(input: unknown): PricedCart {
  const parsed = cartBody.safeParse(input);
  if (!parsed.success) throw invalid("The cart must be a list of products and whole-number quantities.");

  const seen = new Set<string>();
  const lines: PricedCart["lines"] = [];
  let totalCents = 0;
  for (const { id, qty } of parsed.data.items) {
    const product = PRODUCTS.find((p) => p.id === id);
    if (!product) throw invalid("That product isn't in the shop.");
    if (seen.has(id)) throw invalid("List each product once and set its quantity.");
    seen.add(id);
    lines.push({ product, qty });
    totalCents += product.cents * qty;
  }
  if (totalCents > MAX_TOTAL_CENTS) {
    throw invalid(`This is a demo shop, so an order can be at most $${centsToAmount(MAX_TOTAL_CENTS)}.`);
  }
  return {
    lines,
    totalCents,
    amount: centsToAmount(totalCents),
    description: lines.map((l) => `${l.qty} x ${l.product.name}`).join(", "),
  };
}
