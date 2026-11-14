import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ICON_BYTES, createIconService, isSafeSvg, readAssetIcons } from "../src/icons.js";
import type { Token } from "../src/oneclick/types.js";
import { EXPLORER, PNG, SVG, fakeExplorer, notFound, svgResponse } from "./helpers/fakeExplorer.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "tilll-icons-"));
  dirs.push(dir);
  return dir;
};

const token = (blockchain: string, symbol: string): Token => ({
  assetId: `nep141:${blockchain}-${symbol}`,
  decimals: 6,
  blockchain,
  symbol,
  price: 1,
  priceUpdatedAt: "2026-11-10T00:00:00.000Z",
});
const TOKENS = [token("base", "USDC"), token("eth", "USDC"), token("btc", "BTC"), token("sol", "SOL")];

function service(
  fake = fakeExplorer(),
  extra: {
    dir?: string;
    bundledDir?: string;
    tokens?: Token[];
    assetIcons?: Record<string, string | null>;
    now?: () => number;
  } = {},
) {
  const dir = extra.dir ?? tmp();
  const icons = createIconService({
    dir,
    ...(extra.bundledDir ? { bundledDir: extra.bundledDir } : {}),
    ...(extra.assetIcons ? { assetIcons: extra.assetIcons } : {}),
    tokens: { get: async () => extra.tokens ?? TOKENS },
    fetch: fake.fetcher,
    ...(extra.now ? { now: extra.now } : {}),
  });
  return { icons, dir, fake };
}

describe("a token's image", () => {
  it("is fetched from NEAR Intents' explorer by its lowercase symbol, once, however many networks list the token", async () => {
    const { icons, fake } = service();
    const usdc = await icons.tokenIcon("usdc");
    expect(usdc?.type).toBe("image/png");
    expect(usdc?.bytes.equals(PNG)).toBe(true);
    await icons.tokenIcon("usdc");
    expect(fake.urls()).toEqual([`${EXPLORER}token/usdc.png`]);
  });

  it("is kept: a restart reads it from disk with no request", async () => {
    const { icons, dir } = service();
    await icons.tokenIcon("usdc");
    const offline = vi.fn<typeof fetch>(async () => {
      throw new Error("offline");
    });
    const again = createIconService({ dir, tokens: { get: async () => TOKENS }, fetch: offline });
    expect((await again.tokenIcon("usdc"))?.bytes.equals(PNG)).toBe(true);
    expect(offline).not.toHaveBeenCalled();
  });

  it("is only fetched for a symbol some listed token has, written plainly", async () => {
    const { icons, fake } = service();
    expect(await icons.tokenIcon("unlisted")).toBeUndefined();
    for (const bad of ["../../etc/passwd", "USDC", "", "a".repeat(40), "a b", "usdc.png"]) {
      expect([bad, await icons.tokenIcon(bad)]).toEqual([bad, undefined]);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("is never fetched for a token whose symbol is not plain letters and digits", async () => {
    const odd = [token("base", "USDC.e"), token("base", "../etc"), token("base", ""), token("base", "A".repeat(40))];
    const { icons, fake } = service(fakeExplorer(), { tokens: odd });
    for (const id of ["usdc.e", "../etc", "", "a".repeat(40)]) await icons.tokenIcon(id);
    expect(fake.calls).toHaveLength(0);
  });

  it("is fetched once when two people ask at the same moment", async () => {
    const { icons, fake } = service();
    const [a, b] = await Promise.all([icons.tokenIcon("sol"), icons.tokenIcon("sol")]);
    expect(a?.bytes.equals(PNG) && b?.bytes.equals(PNG)).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it("is fetched with redirects refused and a time limit, and only from the explorer", async () => {
    const { icons, fake } = service();
    await icons.tokenIcon("usdc");
    await icons.chainIcon("base");
    for (const call of fake.calls) {
      expect(call.url.startsWith(EXPLORER)).toBe(true);
      expect(call.init?.redirect).toBe("error");
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("is a png, jpeg or webp of a sensible size: html, an error, no type or a huge file is refused", async () => {
    const refused: [string, () => Response][] = [
      ["html", () => new Response("<script>1</script>", { headers: { "content-type": "text/html" } })],
      ["big", () => new Response(Buffer.alloc(MAX_ICON_BYTES + 1), { headers: { "content-type": "image/png" } })],
      ["error", () => new Response("no", { status: 500, headers: { "content-type": "image/png" } })],
      ["none", () => new Response(PNG)],
      ["empty", () => new Response(Buffer.alloc(0), { headers: { "content-type": "image/png" } })],
    ];
    for (const [name, response] of refused) {
      const { icons } = service(fakeExplorer({ respond: response }));
      expect([name, await icons.tokenIcon("usdc")]).toEqual([name, undefined]);
    }
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/png; charset=binary"]) {
      const { icons } = service(
        fakeExplorer({ respond: () => new Response(PNG, { headers: { "content-type": type } }) }),
      );
      expect([type, (await icons.tokenIcon("usdc"))?.type]).toEqual([type, type.split(";")[0]]);
    }
  });

  it("is written only inside its own folder, one file per image", async () => {
    const { icons, dir } = service();
    await icons.tokenIcon("usdc");
    await icons.chainIcon("base");
    expect(readdirSync(dir).toSorted()).toEqual(["chain", "token"]);
    expect(readdirSync(join(dir, "token"))).toEqual(["usdc.png"]);
    expect(readdirSync(join(dir, "chain"))).toEqual(["base.svg"]);
  });
});

describe("the explorer's own table of which picture each token shows", () => {
  const wnear = token("near", "wNEAR");
  const near = token("near", "NEAR");

  it("decides the file, so wNEAR shows NEAR's logo, and the picture is fetched once for both", async () => {
    const assetIcons = { [wnear.assetId]: "near.png", [near.assetId]: "near.png" };
    const { icons, fake } = service(fakeExplorer(), { tokens: [wnear, near], assetIcons });
    expect(icons.iconNameOf(wnear)).toBe("near");
    expect(icons.iconNameOf(near)).toBe("near");
    expect((await icons.tokenIcon("near"))?.bytes.equals(PNG)).toBe(true);
    await icons.tokenIcon("near");
    expect(fake.urls()).toEqual([`${EXPLORER}token/near.png`]);
    // The wrapped symbol is not an image name of its own.
    expect(await icons.tokenIcon("wnear")).toBeUndefined();
  });

  it("can name an SVG, a WebP or a JPG, and the picture keeps the format it was served in", async () => {
    const a = token("aleo", "USAD");
    const b = token("sol", "LOUD");
    const c = token("eth", "PONS");
    const assetIcons = { [a.assetId]: "usad.svg", [b.assetId]: "loud.webp", [c.assetId]: "pons.jpg" };
    const fake = fakeExplorer({
      respond: (url) => {
        if (url.endsWith("usad.svg")) return svgResponse();
        if (url.endsWith("loud.webp")) return new Response(PNG, { headers: { "content-type": "image/webp" } });
        if (url.endsWith("pons.jpg")) return new Response(PNG, { headers: { "content-type": "image/jpeg" } });
        return undefined;
      },
    });
    const { icons, dir } = service(fake, { tokens: [a, b, c], assetIcons });
    expect((await icons.tokenIcon("usad"))?.type).toBe("image/svg+xml");
    expect((await icons.tokenIcon("loud"))?.type).toBe("image/webp");
    expect((await icons.tokenIcon("pons"))?.type).toBe("image/jpeg");
    expect(readdirSync(join(dir, "token")).toSorted()).toEqual(["loud.webp", "pons.jpeg", "usad.svg"]);
  });

  it("says a token has no picture when the table says so, and then asks nobody for one", async () => {
    const frax = token("near", "FRAX");
    const { icons, fake } = service(fakeExplorer(), { tokens: [frax], assetIcons: { [frax.assetId]: null } });
    expect(icons.iconNameOf(frax)).toBeUndefined();
    expect(await icons.tokenIcon("frax")).toBeUndefined();
    expect((await icons.sync()).added).toBe(11); // only the networks
    expect(fake.urls().some((u) => u.includes("/token/"))).toBe(false);
  });

  it("falls back to the lowercase symbol for a token the table does not know yet", async () => {
    const fresh = token("base", "NEWCOIN");
    const { icons, fake } = service(fakeExplorer(), { tokens: [fresh], assetIcons: { "nep141:other": "x.png" } });
    expect(icons.iconNameOf(fresh)).toBe("newcoin");
    await icons.tokenIcon("newcoin");
    expect(fake.urls()).toEqual([`${EXPLORER}token/newcoin.png`]);
  });

  it("never puts a file name that is not a plain picture name into an address", async () => {
    const bad = ["../x.png", "a b.png", "x.exe", "A.png", "a/b.png", "", "a".repeat(60) + ".png"];
    const tokens = bad.map((_, i) => token("base", `T${i}`));
    const assetIcons = Object.fromEntries(tokens.map((t, i) => [t.assetId, bad[i]!]));
    const { icons, fake } = service(fakeExplorer(), { tokens, assetIcons });
    for (const t of tokens) expect([t.symbol, icons.iconNameOf(t)]).toEqual([t.symbol, undefined]);
    await icons.sync();
    expect(fake.urls().some((u) => u.includes("/token/"))).toBe(false);
  });

  it("is looked for under the file's name when the snapshot is checked", async () => {
    const { icons, fake } = service(fakeExplorer(), {
      tokens: [wnear],
      assetIcons: { [wnear.assetId]: "near.png" },
    });
    await icons.sync();
    expect(fake.urls().filter((u) => u.includes("/token/"))).toEqual([`${EXPLORER}token/near.png`]);
  });
});

describe("reading the table that ships with Tilll", () => {
  it("is the token-map.json in the images folder, and is empty when it is missing or broken", () => {
    const ok = snapshot({ "token-map.json": Buffer.from(JSON.stringify({ "nep141:a": "a.png", "nep141:b": null })) });
    expect(readAssetIcons(ok)).toEqual({ "nep141:a": "a.png", "nep141:b": null });
    expect(readAssetIcons(tmp())).toEqual({});
    expect(readAssetIcons(snapshot({ "token-map.json": Buffer.from("{broken") }))).toEqual({});
    expect(readAssetIcons(snapshot({ "token-map.json": Buffer.from("[1,2]") }))).toEqual({});
  });
});

describe("when the explorer has no picture, or does not answer", () => {
  it("gives none, and does not ask again for a day, however often the list is opened", async () => {
    let time = 5_000_000;
    const fake = fakeExplorer({ respond: () => notFound() });
    const { icons } = service(fake, { now: () => time });
    expect(await icons.tokenIcon("usdc")).toBeUndefined();
    expect(await icons.tokenIcon("usdc")).toBeUndefined();
    time += 23 * 60 * 60_000;
    expect(await icons.tokenIcon("usdc")).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
    time += 2 * 60 * 60_000;
    await icons.tokenIcon("usdc");
    expect(fake.calls).toHaveLength(2);
  });

  it("is quiet when it is down: nothing is returned, nothing is thrown", async () => {
    const { icons } = service(fakeExplorer({ down: true }));
    expect(await icons.tokenIcon("usdc")).toBeUndefined();
    expect(await icons.chainIcon("base")).toBeUndefined();
    expect(await icons.sync()).toEqual({ added: 0 });
  });
});

describe("a network's image", () => {
  it("is an SVG named as the explorer names it", async () => {
    const { icons, fake } = service();
    expect((await icons.chainIcon("base"))?.type).toBe("image/svg+xml");
    await icons.chainIcon("eth");
    await icons.chainIcon("arb");
    await icons.chainIcon("btc");
    expect(fake.urls()).toEqual([
      `${EXPLORER}network/base.svg`,
      `${EXPLORER}network/ethereum.svg`,
      `${EXPLORER}network/arbitrum.svg`,
      `${EXPLORER}network/btc.svg`,
    ]);
  });

  it("takes the dark-ink version of NEAR's mark, since the badge is light and the plain one is white", async () => {
    const { icons, fake } = service();
    await icons.chainIcon("near");
    expect(fake.urls()).toEqual([`${EXPLORER}network/near_dark.svg`]);
  });

  it("is missing for a network the map does not know, with no request, and the known ones are listed", async () => {
    const { icons, fake } = service();
    expect(await icons.chainIcon("aptos")).toBeUndefined();
    expect(await icons.chainIcon("../x")).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
    expect([...icons.chainsWithIcon].toSorted()).toEqual(
      ["arb", "avax", "base", "bsc", "btc", "eth", "near", "op", "pol", "sol", "tron"].toSorted(),
    );
  });
});

describe("an SVG from the explorer", () => {
  const refused: [string, string][] = [
    ["a script", SVG("<script>alert(1)</script>")],
    ["an event handler", SVG('<g onload="alert(1)"/>')],
    ["a foreign object", SVG("<foreignObject><div/></foreignObject>")],
    ["a link to another site", SVG('<image href="https://evil.example/x.png"/>')],
    ["a javascript link", SVG('<a xlink:href="javascript:alert(1)"/>')],
    ["an entity", `<!DOCTYPE svg [<!ENTITY x "y">]>${SVG()}`],
    ["not an svg", "<html><body>hi</body></html>"],
    ["too big", SVG("x".repeat(MAX_ICON_BYTES))],
  ];

  it.each(refused)("is not accepted when it has %s", async (_name, body) => {
    const { icons } = service(fakeExplorer({ respond: () => svgResponse(body) }));
    expect(await icons.chainIcon("base")).toBeUndefined();
    expect(isSafeSvg(Buffer.from(body))).toBe(false);
  });

  it("is accepted when it is plain drawing, including one that points inside itself", () => {
    expect(isSafeSvg(Buffer.from(SVG()))).toBe(true);
    const inner = SVG('<use href="#a"/><defs><path id="a" d="M0 0"/></defs>');
    expect(isSafeSvg(Buffer.from(`<?xml version="1.0"?>${inner}`))).toBe(true);
  });

  it("is only accepted with the right type", async () => {
    const { icons } = service(fakeExplorer({ respond: () => svgResponse(SVG(), "text/html") }));
    expect(await icons.chainIcon("base")).toBeUndefined();
  });
});

/** A folder laid out like public/icons: token/<name>.<ext>, chain/<network>.svg and token-map.json. */
function snapshot(files: Record<string, Buffer>) {
  const dir = tmp();
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), bytes);
  }
  return dir;
}

describe("the bundled snapshot", () => {
  const BUNDLED = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);

  it("is served first, with no request at all, and is never copied into the cache", async () => {
    const bundledDir = snapshot({ "token/usdc.png": BUNDLED, "chain/base.svg": Buffer.from(SVG()) });
    const { icons, dir, fake } = service(fakeExplorer(), { bundledDir });
    expect((await icons.tokenIcon("usdc"))?.bytes.equals(BUNDLED)).toBe(true);
    expect((await icons.chainIcon("base"))?.type).toBe("image/svg+xml");
    expect(fake.calls).toHaveLength(0);
    expect(existsSync(join(dir, "token"))).toBe(false);
  });

  it("is only used for symbols that are listed", async () => {
    const bundledDir = snapshot({ "token/unlisted.png": BUNDLED });
    const { icons } = service(fakeExplorer(), { bundledDir });
    expect(await icons.tokenIcon("unlisted")).toBeUndefined();
  });

  it("reads webp and jpeg files too, and reports their type", async () => {
    const bundledDir = snapshot({ "token/usdc.webp": BUNDLED, "token/sol.jpeg": BUNDLED });
    const { icons } = service(fakeExplorer(), { bundledDir });
    expect((await icons.tokenIcon("usdc"))?.type).toBe("image/webp");
    expect((await icons.tokenIcon("sol"))?.type).toBe("image/jpeg");
  });
});

describe("checking for new images", () => {
  it("downloads only the images that are not bundled or kept yet, and says how many", async () => {
    const bundledDir = snapshot({ "token/usdc.png": PNG });
    const { icons, dir, fake } = service(fakeExplorer(), { bundledDir });

    const first = await icons.sync();
    // btc and sol (usdc is bundled) and the eleven networks
    expect(first.added).toBe(13);
    expect(fake.calls).toHaveLength(13);
    expect(readdirSync(join(dir, "token")).toSorted()).toEqual(["btc.png", "sol.png"]);
    expect(readdirSync(join(dir, "chain"))).toHaveLength(11);

    expect((await icons.sync()).added).toBe(0);
    expect(fake.calls).toHaveLength(13);
  });

  it("finds a new token on a later check, and leaves the old ones alone", async () => {
    let list = TOKENS;
    const fake = fakeExplorer();
    const dir = tmp();
    const icons = createIconService({ dir, tokens: { get: async () => list }, fetch: fake.fetcher });
    await icons.sync();
    const before = fake.calls.length;

    list = [...TOKENS, token("base", "NEW")];
    const later = createIconService({ dir, tokens: { get: async () => list }, fetch: fake.fetcher });
    expect((await later.sync()).added).toBe(1);
    expect(fake.calls).toHaveLength(before + 1);
    expect(fake.urls().at(-1)).toBe(`${EXPLORER}token/new.png`);
  });

  it("counts only the images it really got", async () => {
    const { icons } = service(
      fakeExplorer({ respond: (url) => (url.includes("/token/sol") ? notFound() : undefined) }),
    );
    const { added } = await icons.sync();
    expect(added).toBe(2 + 11); // usdc and btc are found, sol is not; all eleven networks are
  });
});
