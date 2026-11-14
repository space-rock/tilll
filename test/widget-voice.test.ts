import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = readdirSync(join(root, "widget/src"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => `widget/src/${f}`);

/** The text of a source file without its comments, which may name things the screen does not. */
const withoutComments = (file: string) =>
  readFileSync(join(root, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the pay widget's voice", () => {
  it("speaks plainly: no provider names, one name for the payment address, contractions instead of 'could not'", () => {
    const banned = [
      /1Click/,
      /Deposit address/,
      /deposit address/,
      /Invoice (expired|canceled|not found)/,
      /Loading invoice/,
      /\b(could not|did not|does not|cannot|do not)\b/i,
      /Please try again/,
    ];
    const found = sources.flatMap((file) =>
      banned.filter((rule) => rule.test(withoutComments(file))).map((rule) => `${file}: ${rule.source}`),
    );
    expect(found).toEqual([]);
  });

  it("has no exclamation marks in what it says", () => {
    const found = sources.flatMap((file) =>
      [...withoutComments(file).matchAll(/"([^"\n]*[A-Za-z][^"\n]*!)"/g)].map((m) => `${file}: ${m[1]}`),
    );
    expect(found).toEqual([]);
  });
});
