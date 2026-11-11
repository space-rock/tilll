import { describe, expect, it } from "vitest";
import { newId } from "../src/ids.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Decode the 10-character ULID timestamp back to milliseconds. */
function decodeTime(ulid: string): number {
  return Array.from(ulid.slice(0, 10)).reduce((acc, ch) => acc * 32 + CROCKFORD.indexOf(ch), 0);
}

describe("newId", () => {
  it("is the prefix, an underscore and a 26 character Crockford base32 ULID", () => {
    expect(newId("inv")).toMatch(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newId("att")).toMatch(/^att_/);
  });

  it("encodes the creation time in the first 10 characters", () => {
    const at = Date.UTC(2026, 10, 5, 10, 0, 0);
    expect(decodeTime(newId("inv", { now: at }).slice(4))).toBe(at);
  });

  it("sorts by creation time, so ORDER BY id is chronological", () => {
    const ids = [3_000, 1_000, 2_000, 1_000_000_000_000].map((now) => newId("inv", { now }));
    expect(ids.toSorted()).toEqual([ids[1], ids[2], ids[0], ids[3]]);
  });

  it("is unique even within the same millisecond", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId("evt", { now: 5 })));
    expect(ids.size).toBe(1000);
  });

  it("uses the injected randomness for the last 16 characters", () => {
    const zeros = newId("inv", { now: 0, random: () => new Uint8Array(10) });
    expect(zeros).toBe("inv_" + "0".repeat(10) + "0".repeat(16));
    const ones = newId("inv", { now: 0, random: () => new Uint8Array(10).fill(255) });
    expect(ones.slice(14)).toBe("Z".repeat(16));
  });
});
