import { describe, expect, it } from "vitest";
import { amountSize, formatCountdown, hostLabel, shorten } from "../widget/src/format.js";

describe("formatCountdown", () => {
  it.each([
    [29 * 60_000 + 59_000, "29:59"],
    [5_000, "00:05"],
    [60_000, "01:00"],
    [59 * 60_000 + 59_000, "59:59"],
    [60 * 60_000, "1h 00m"],
    [2 * 3_600_000 + 5 * 60_000, "2h 05m"],
    [26 * 3_600_000, "1d 2h"],
    [0, "00:00"],
    [-5_000, "00:00"],
    [Number.NaN, "00:00"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatCountdown(ms)).toBe(expected);
  });

  it("rounds a partial second up, so the clock never shows 00:00 while time remains", () => {
    expect(formatCountdown(400)).toBe("00:01");
  });
});

describe("shorten", () => {
  it("keeps the start and end of a long address and marks the gap", () => {
    expect(shorten("0x1111111111111111111111111111111111111111")).toBe("0x111111…111111");
    expect(shorten("0x1111111111111111111111111111111111111111", 4, 4)).toBe("0x11…1111");
  });

  it("leaves a short string alone", () => {
    expect(shorten("alice.near")).toBe("alice.near");
  });
});

describe("hostLabel", () => {
  it("labels an explorer link with its host", () => {
    expect(hostLabel("https://basescan.org/tx/0xabc")).toBe("basescan.org");
    expect(hostLabel("https://www.solscan.io/tx/x")).toBe("solscan.io");
  });

  it("falls back to a generic label for a URL it cannot read", () => {
    expect(hostLabel("not a url")).toBe("explorer");
  });
});

describe("amountSize", () => {
  it.each([
    ["5.051529 USDC", ""],
    ["12345678.1234 USDC", ""], // 18 characters: 18 x 20px of monospace still fits a card 400 pixels wide
    ["12345678.12345 USDC", "long"], // 19 do not
    ["0.0000000001262875 wNEAR", "long"],
    ["0.00000000000000001262875 wNEAR", "longer"],
    ["0.000000000000000000000000001262875 wNEAR", "longer"],
  ])("draws %s at size %j", (text, size) => {
    expect(amountSize(text)).toBe(size);
  });

  it("gets smaller as the text gets longer, never larger", () => {
    const order = ["", "long", "longer"];
    let last = 0;
    for (let length = 1; length <= 60; length++) {
      const at = order.indexOf(amountSize("9".repeat(length)));
      expect(at).toBeGreaterThanOrEqual(last);
      last = at;
    }
  });
});
