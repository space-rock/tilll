// Reading NEAR Intents' explorer: which image file it shows for each token. Used by `pnpm icons:update` only; nothing
// here runs in the server. The explorer's source is not public, but its browser script is, and that script carries a
// table from asset id to image file. We read it as text and never run it.

/** A plain picture name, as the explorer's table gives it: `usdc.png`, `usad.svg`. */
const FILE = /^[a-z0-9]{1,40}\.(?:png|svg|jpg|jpeg|webp)$/;

/**
 * The explorer's table as `{ assetId: file }`, or `null` for an asset it shows no picture for. Nothing when the script
 * holds no such table, so an update can say so instead of guessing.
 */
export function extractIconTable(script: string): Record<string, string | null> | undefined {
  const folder = script.indexOf('"/icons/token/"');
  if (folder === -1) return undefined;
  const start = script.lastIndexOf("JSON.parse('", folder);
  if (start === -1) return undefined;
  const from = start + "JSON.parse('".length;
  const end = script.indexOf("')", from);
  if (end === -1 || end > folder) return undefined;
  let table: unknown;
  try {
    table = JSON.parse(script.slice(from, end).replaceAll("\\'", "'"));
  } catch {
    return undefined;
  }
  if (typeof table !== "object" || table === null || Array.isArray(table)) return undefined;
  const entries = Object.entries(table as Record<string, { icon?: unknown } | null>);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([assetId, row]) => [assetId, typeof row?.icon === "string" && FILE.test(row.icon) ? row.icon : null]),
  );
}

/** The script files a page loads from its own site, once each. */
export function chunkUrls(html: string, origin: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
    try {
      const url = new URL(match[1]!, origin);
      if (url.origin === origin) urls.add(url.href);
    } catch {
      // not an address
    }
  }
  return [...urls];
}
