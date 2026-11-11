import { describe, expect, it } from "vitest";
import { thrown } from "./helpers/failure.js";
import { MoneyError, fromBaseUnits, toBaseUnits } from "../src/money.js";

describe("toBaseUnits", () => {
  it("converts a whole number of display units", () => {
    expect(toBaseUnits("5", 6)).toBe("5000000");
  });

  it("converts a decimal amount without float rounding", () => {
    expect(toBaseUnits("5.25", 6)).toBe("5250000");
    expect(toBaseUnits("0.000001", 6)).toBe("1");
    expect(toBaseUnits("0.1", 24)).toBe("100000000000000000000000");
  });

  it("rejects more fractional digits than the asset has decimals instead of truncating", () => {
    expect(() => toBaseUnits("0.0000001", 6)).toThrow(/at most 6 decimal/);
  });

  it.each(["", "abc", "-5", "+5", "1e5", "1.2.3", ".5", "5.", " 5", "5 "])("rejects malformed amount %j", (bad) => {
    expect(() => toBaseUnits(bad, 6)).toThrow(/invalid amount/i);
  });
});

describe("fromBaseUnits", () => {
  it("formats base units as a minimal decimal string", () => {
    expect(fromBaseUnits("5000000", 6)).toBe("5");
    expect(fromBaseUnits("5250000", 6)).toBe("5.25");
    expect(fromBaseUnits("1", 6)).toBe("0.000001");
    expect(fromBaseUnits("0", 6)).toBe("0");
    expect(fromBaseUnits("100000000000000000000000", 24)).toBe("0.1");
  });

  it("round-trips with toBaseUnits", () => {
    for (const [display, decimals] of [
      ["12.345678", 6],
      ["0.5", 18],
      ["1000000", 0],
    ] as const) {
      expect(fromBaseUnits(toBaseUnits(display, decimals), decimals)).toBe(display);
    }
  });

  it.each(["", "1.5", "-1", "abc"])("rejects non-integer base units %j", (bad) => {
    expect(() => fromBaseUnits(bad, 6)).toThrow(/invalid base-unit/i);
  });
});

describe("MoneyError", () => {
  it("is the error type for every rejected amount, so callers can tell bad input from a bug", () => {
    expect(thrown(() => toBaseUnits("abc", 6))).toBeInstanceOf(MoneyError);
    expect(thrown(() => toBaseUnits("0.0000001", 6))).toBeInstanceOf(MoneyError);
    expect(thrown(() => fromBaseUnits("-1", 6))).toBeInstanceOf(MoneyError);
  });
});

/** A small deterministic generator, so a failure is reproducible. */
const generator = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
};
const canonical = (whole: string, frac: string) => {
  const w = whole.replace(/^0+(?=\d)/, "");
  const f = frac.replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
};

describe("conversion, over many random amounts", () => {
  it("round-trips display to base units to display, and never changes the value, for 6 to 24 decimals and huge numbers", () => {
    const next = generator(20261109);
    for (let i = 0; i < 3000; i++) {
      const decimals = next() % 25;
      const wholeLength = 1 + (next() % 40);
      const fracLength = decimals === 0 ? 0 : next() % (decimals + 1);
      const digits = (n: number) => Array.from({ length: n }, () => String(next() % 10)).join("");
      const whole = digits(wholeLength);
      const frac = digits(fracLength);
      const display = frac ? `${whole}.${frac}` : whole;

      const base = toBaseUnits(display, decimals);

      expect(base).toMatch(/^(0|[1-9]\d*)$/);
      expect(fromBaseUnits(base, decimals)).toBe(canonical(whole, frac));
      expect(BigInt(base)).toBe(BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0"));
    }
  });

  it("refuses one decimal place too many at every precision", () => {
    for (let decimals = 0; decimals <= 24; decimals++) {
      expect(() => toBaseUnits(`1.${"1".repeat(decimals + 1)}`, decimals)).toThrow(MoneyError);
      expect(() => toBaseUnits(decimals === 0 ? "1" : `1.${"1".repeat(decimals)}`, decimals)).not.toThrow();
    }
  });
});
