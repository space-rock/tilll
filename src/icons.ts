import { readFileSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Token } from "./oneclick/types.js";

/**
 * Token and network images for the checkout. 1Click's token list has none. A snapshot of the current ones ships in
 * `public/icons`, with the explorer's own table of which file each token shows (`token-map.json`). For a token that is
 * not in the snapshot, this server asks NEAR Intents' explorer, which serves the images its own site shows, keeps the
 * file in its data folder, and serves everything from its own address. The payer's browser never contacts the
 * explorer. Without a picture, the checkout shows a letter.
 *
 * What it will fetch is narrow on purpose: an address this file builds from a plain picture name (from the table, or a
 * plain lowercase symbol for a token the table does not know yet) or a fixed network name, with redirects refused, a time limit, and at most 100 kB. A png, jpeg or webp; an SVG only if it is
 * plain drawing (no script, handler, outside link or entity), because an SVG can carry script.
 */

export const MAX_ICON_BYTES = 100 * 1024;

/** NEAR Intents' explorer serves its images as plain files: `token/<symbol>.png`, `network/<name>.svg`. */
const EXPLORER = "https://explorer.near-intents.org/icons";
const TIMEOUT_MS = 5000;
/** A picture the explorer does not have is asked for again after a day, not every time someone opens the list. */
const MISS_TTL_MS = 24 * 60 * 60_000;
/** A token that the table does not know yet is looked for by its plain lowercase symbol. */
const SYMBOL = /^[a-z0-9]{1,20}$/;
/** What a token's image is called: the file's name without its format. */
const NAME = /^[a-z0-9]{1,40}$/;
/** A picture file as the explorer names it: `usdc.png`, `usad.svg`. */
const FILE = /^[a-z0-9]{1,40}\.(?:png|svg|jpg|jpeg|webp)$/;
const CHAIN_ID = /^[a-z0-9]{2,12}$/;

const TYPE_OF_EXT: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};
const EXT_OF_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** 1Click's network ids to what the explorer calls that network's picture (`network/<name>.svg`). */
const NETWORKS: Record<string, string> = {
  eth: "ethereum",
  base: "base",
  arb: "arbitrum",
  op: "optimism",
  pol: "polygon",
  bsc: "bsc",
  avax: "avalanche",
  sol: "solana",
  // The plain `near.svg` is a white mark for dark backgrounds; the badge is light, so take the dark-ink one.
  near: "near_dark",
  tron: "tron",
  btc: "btc",
};

export interface Icon {
  bytes: Buffer;
  type: string;
}

export interface IconServiceOptions {
  /** Where images fetched later are kept, for example `<DATA_DIR>/icons`: `token/<symbol>.<ext>`, `chain/<network>.<ext>`. */
  dir: string;
  /** A read-only folder of images with the same layout, shipped with Tilll (`public/icons`). Looked at first. */
  bundledDir?: string;
  tokens: { get(): Promise<Token[]> };
  /**
   * The explorer's table of which picture file each token shows (asset id to file, or `null` for none), as shipped in
   * `token-map.json`. Without it, or for a token it lacks, the token's lowercase symbol names the file.
   */
  assetIcons?: Record<string, string | null>;
  fetch?: typeof fetch;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
}

/** A link that stays inside the picture: to a part of itself, or an embedded png, jpeg or webp. */
const staysInside = (target: string) =>
  target.startsWith("#") || /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(target);

/**
 * Whether an SVG is plain drawing: it starts as an SVG and has no script, event handler, foreign object, entity,
 * animation, or link to anything but itself (or an embedded png, jpeg or webp). Served from this server it is also sent
 * with a sandboxing policy, so this is a second lock, not the only one.
 */
export function isSafeSvg(bytes: Buffer): boolean {
  if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return false;
  const text = bytes.toString("utf8");
  if (!/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) return false;
  if (
    /<!DOCTYPE|<!ENTITY|<script|<foreignObject|<iframe|<object|<embed|<audio|<video|<animate|<set\b|<handler|javascript:|vbscript:|\bon[a-z]+\s*=/i.test(
      text,
    )
  )
    return false;
  for (const link of text.matchAll(/(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi))
    if (!staysInside(link[2]!.trim())) return false;
  for (const ref of text.matchAll(/url\(\s*["']?([^)"']*)/gi)) if (!staysInside(ref[1]!.trim())) return false;
  return true;
}

/** Every outside request: redirects refused, and a time limit. */
const guarded = (): RequestInit => ({ redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });

/** The body of a response, or nothing if it is, or turns out to be, bigger than an icon may be. */
async function readCapped(response: Response): Promise<Buffer | undefined> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_ICON_BYTES || !response.body) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ICON_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** A picture file's name without its format: `usdc.png` is `usdc`. */
const stemOf = (file: string) => file.slice(0, file.lastIndexOf("."));

/** The picture file for a token: the table's, or `<symbol>.png` for a token the table does not know. */
function iconFileOf(token: Pick<Token, "assetId" | "symbol">, table: Record<string, string | null> | undefined) {
  if (table && Object.hasOwn(table, token.assetId)) {
    const file = table[token.assetId];
    return typeof file === "string" && FILE.test(file) ? file : undefined;
  }
  const symbol = token.symbol.toLowerCase();
  return SYMBOL.test(symbol) ? `${symbol}.png` : undefined;
}

/** The table shipped with Tilll, `<dir>/token-map.json`. Empty when it is missing or not a table. */
export function readAssetIcons(dir: string): Record<string, string | null> {
  try {
    const table: unknown = JSON.parse(readFileSync(join(dir, "token-map.json"), "utf8"));
    return typeof table === "object" && table !== null && !Array.isArray(table)
      ? (table as Record<string, string | null>)
      : {};
  } catch {
    return {};
  }
}

type Kind = "token" | "chain";

/** The file for an image under `root`, in whichever format it was saved. `name` is already checked. */
async function fileFor(root: string, kind: Kind, name: string): Promise<string | undefined> {
  for (const ext of Object.keys(TYPE_OF_EXT)) {
    const path = join(root, kind, `${name}.${ext}`);
    try {
      await access(path);
      return path;
    } catch {
      // not in this format
    }
  }
  return undefined;
}

async function readFrom(root: string | undefined, kind: Kind, name: string): Promise<Icon | undefined> {
  if (!root) return undefined;
  const path = await fileFor(root, kind, name);
  if (!path) return undefined;
  try {
    return { bytes: await readFile(path), type: TYPE_OF_EXT[path.slice(path.lastIndexOf(".") + 1)]! };
  } catch {
    return undefined;
  }
}

export function createIconService(options: IconServiceOptions) {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const memory = new Map<string, Icon>();
  const missUntil = new Map<string, number>();
  const pending = new Map<string, Promise<unknown>>();

  /** Run `work` once at a time per key: people who ask together share one request. */
  function once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const running = pending.get(key) as Promise<T> | undefined;
    if (running) return running;
    const started = work().finally(() => pending.delete(key));
    pending.set(key, started);
    return started;
  }

  /** An image from the explorer, if it is one this service accepts. `path` is built here from checked names only. */
  async function download(path: string): Promise<Icon | undefined> {
    try {
      const response = await request(`${EXPLORER}/${path}`, guarded());
      const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!response.ok || !(type in EXT_OF_TYPE)) return undefined;
      const bytes = await readCapped(response);
      if (!bytes || bytes.length === 0) return undefined;
      if (type === "image/svg+xml" && !isSafeSvg(bytes)) return undefined;
      return { bytes, type };
    } catch {
      return undefined;
    }
  }

  async function keep(kind: Kind, name: string, icon: Icon): Promise<void> {
    try {
      await mkdir(join(options.dir, kind), { recursive: true });
      await writeFile(join(options.dir, kind, `${name}.${EXT_OF_TYPE[icon.type]}`), icon.bytes);
    } catch {
      // Not keeping a copy only means asking again later.
    }
  }

  /** Memory, then the bundled snapshot, then the data folder, then the explorer (`path` there). */
  function load(kind: Kind, name: string, path: string): Promise<Icon | undefined> {
    const id = `${kind}/${name}`;
    const known = memory.get(id);
    if (known) return Promise.resolve(known);
    return once(`icon:${id}`, async () => {
      const kept = (await readFrom(options.bundledDir, kind, name)) ?? (await readFrom(options.dir, kind, name));
      if (kept) {
        memory.set(id, kept);
        return kept;
      }
      if ((missUntil.get(id) ?? 0) > now()) return undefined;
      const icon = await download(path);
      if (!icon) {
        missUntil.set(id, now() + MISS_TTL_MS);
        return undefined;
      }
      memory.set(id, icon);
      await keep(kind, name, icon);
      return icon;
    });
  }

  /** What a token's image is called, or nothing when it has none. */
  const iconNameOf = (token: Pick<Token, "assetId" | "symbol">): string | undefined => {
    const file = iconFileOf(token, options.assetIcons);
    return file ? stemOf(file) : undefined;
  };

  /** A token's picture, by its image name. Only a plain name that some listed token has is ever asked for. */
  async function tokenIcon(name: string): Promise<Icon | undefined> {
    if (!NAME.test(name)) return undefined;
    for (const token of await options.tokens.get()) {
      const file = iconFileOf(token, options.assetIcons);
      if (file && stemOf(file) === name) return load("token", name, `token/${file}`);
    }
    return undefined;
  }

  async function chainIcon(chain: string): Promise<Icon | undefined> {
    if (!CHAIN_ID.test(chain) || !Object.hasOwn(NETWORKS, chain)) return undefined;
    return load("chain", chain, `network/${NETWORKS[chain]}.svg`);
  }

  const have = async (kind: Kind, name: string) =>
    memory.has(`${kind}/${name}`) ||
    (await fileFor(options.dir, kind, name)) !== undefined ||
    (options.bundledDir !== undefined && (await fileFor(options.bundledDir, kind, name)) !== undefined);

  /**
   * Look for tokens and networks that have no image yet (new ones in 1Click's list, or any the snapshot lacks) and
   * download them. Never throws: with the explorer out of reach it adds nothing and the next check tries again.
   */
  function sync(): Promise<{ added: number }> {
    return once("sync", async () => {
      let added = 0;
      try {
        const names = [...new Set((await options.tokens.get()).flatMap((t) => iconNameOf(t) ?? []))];
        for (const name of names) {
          if (await have("token", name)) continue;
          await tokenIcon(name);
          if (await have("token", name)) added++;
        }
        for (const chain of Object.keys(NETWORKS)) {
          if (await have("chain", chain)) continue;
          await chainIcon(chain);
          if (await have("chain", chain)) added++;
        }
      } catch {
        // reported by nothing: a later check tries again
      }
      return { added };
    });
  }

  return { tokenIcon, chainIcon, iconNameOf, sync, chainsWithIcon: Object.keys(NETWORKS) as readonly string[] };
}

export type IconService = ReturnType<typeof createIconService>;
