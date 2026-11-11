// `pnpm icons:update`: refresh public/icons for the current 1Click token list.
//   1. read NEAR Intents' explorer for the table of which picture each token shows (public/icons/token-map.json);
//   2. download the pictures the snapshot lacks (it only adds; delete a file first to fetch it again).
// Run it, look at what changed, and commit the files. The explorer's source is not public, so step 1 reads its browser
// script as text; if that ever stops working the script says so and keeps the table it has.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createIconService, readAssetIcons } from "../src/icons.js";
import type { Token } from "../src/oneclick/types.js";
import { chunkUrls, extractIconTable } from "./explorer-table.js";

const baseUrl = process.env["ONECLICK_BASE_URL"] ?? "https://1click.chaindefuser.com";
const explorer = "https://explorer.near-intents.org";
const dir = fileURLToPath(new URL("../public/icons", import.meta.url));

async function text(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response.text();
}

const tokens = JSON.parse(await text(`${baseUrl}/v0/tokens`)) as Token[];

let assetIcons = readAssetIcons(dir);
let table: Record<string, string | null> | undefined;
for (const url of chunkUrls(await text(explorer), explorer)) {
  table = extractIconTable(await text(url));
  if (table) break;
}
if (table) {
  // Only the tokens 1Click lists now; a token the explorer's table lacks is left out, so its symbol names its picture.
  assetIcons = Object.fromEntries(
    tokens
      .filter((t) => Object.hasOwn(table, t.assetId))
      .map((t) => [t.assetId, table[t.assetId] ?? null] as const)
      .toSorted(([a], [b]) => a.localeCompare(b)),
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "token-map.json"), `${JSON.stringify(assetIcons, null, 2)}\n`);
  console.log(`Read the explorer's table: ${Object.keys(assetIcons).length} of ${tokens.length} tokens are in it.`);
} else {
  console.error("Could not find the explorer's table of token pictures. Keeping the table that ships with Tilll.");
}

const icons = createIconService({ dir, assetIcons, tokens: { get: async () => tokens } });
const { added } = await icons.sync();

const count = (kind: string) => {
  try {
    return readdirSync(join(dir, kind)).length;
  } catch {
    return 0;
  }
};
console.log(
  `Added ${added}. public/icons now holds ${count("token")} token images and ${count("chain")} network images.`,
);
