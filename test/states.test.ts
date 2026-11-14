import { describe, expect, it } from "vitest";
import { isTerminalAttempt, nextAttemptStatus, type AttemptStatus } from "../src/invoices/states.js";
import type { SwapStatus } from "../src/oneclick/types.js";

describe("nextAttemptStatus (PLAN section 8 mapping)", () => {
  it.each<[SwapStatus, AttemptStatus]>([
    ["PENDING_DEPOSIT", "awaiting"],
    ["KNOWN_DEPOSIT_TX", "confirming"],
    ["PROCESSING", "confirming"],
    ["INCOMPLETE_DEPOSIT", "underpaid"],
    ["SUCCESS", "paid"],
    ["REFUNDED", "refunded"],
    ["FAILED", "failed"],
  ])("maps 1Click %s to %s for a live attempt", (swap, expected) => {
    expect(nextAttemptStatus("awaiting", swap)).toBe(expected);
  });

  it("keeps a superseded attempt superseded while no deposit has arrived", () => {
    expect(nextAttemptStatus("superseded", "PENDING_DEPOSIT")).toBe("superseded");
  });

  it.each<[SwapStatus, AttemptStatus]>([
    ["KNOWN_DEPOSIT_TX", "confirming"],
    ["PROCESSING", "confirming"],
    ["INCOMPLETE_DEPOSIT", "underpaid"],
    ["SUCCESS", "paid"],
  ])("lets a superseded attempt move on once money shows up: %s -> %s", (swap, expected) => {
    expect(nextAttemptStatus("superseded", swap)).toBe(expected);
  });

  it.each<AttemptStatus>(["paid", "refunded", "failed"])("never leaves terminal state %s", (terminal) => {
    for (const swap of ["PENDING_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"] as SwapStatus[]) {
      expect(nextAttemptStatus(terminal, swap)).toBe(terminal);
    }
  });

  it("moves an underpaid attempt forward when it is topped up, or on to refunded", () => {
    expect(nextAttemptStatus("underpaid", "PROCESSING")).toBe("confirming");
    expect(nextAttemptStatus("underpaid", "SUCCESS")).toBe("paid");
    expect(nextAttemptStatus("underpaid", "REFUNDED")).toBe("refunded");
  });
});

describe("isTerminalAttempt", () => {
  it("is true only for paid, refunded and failed", () => {
    const all: AttemptStatus[] = ["awaiting", "confirming", "underpaid", "paid", "refunded", "failed", "superseded"];
    expect(all.filter(isTerminalAttempt)).toEqual(["paid", "refunded", "failed"]);
  });
});
