/** A rejected amount: malformed, negative, or more precise than the asset allows. Bad input, not a bug. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const INTEGER = /^\d+$/;

/** Format an integer base-unit string as a minimal decimal string ("5250000", 6 -> "5.25"). */
export function fromBaseUnits(base: string, decimals: number): string {
  if (!INTEGER.test(base))
    throw new MoneyError(`Invalid base-unit amount ${JSON.stringify(base)}: expected a non-negative integer string`);
  const digits = base.padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Convert a decimal display amount ("5.25") to an integer base-unit string. BigInt only, no floats. */
export function toBaseUnits(display: string, decimals: number): string {
  const match = DECIMAL.exec(display);
  if (!match) throw new MoneyError(`Invalid amount ${JSON.stringify(display)}: expected a plain decimal like "5.25"`);
  const whole = match[1]!;
  const frac = match[2] ?? "";
  if (frac.length > decimals) {
    throw new MoneyError(`Invalid amount ${JSON.stringify(display)}: at most ${decimals} decimal places allowed`);
  }
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0")).toString();
}
