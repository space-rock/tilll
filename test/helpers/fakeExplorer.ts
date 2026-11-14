import { vi } from "vitest";

/** The first bytes of a PNG, which is all the server checks apart from the declared type. */
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
export const EXPLORER = "https://explorer.near-intents.org/icons/";

/** A plain drawing, as the explorer serves for a network. `extra` goes inside it. */
export const SVG = (extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="111" height="111" fill="none"><path fill="#0052FF" d="M0 0h10v10z"/>${extra}</svg>`;

export const pngResponse = () => new Response(PNG, { headers: { "content-type": "image/png" } });
export const svgResponse = (body = SVG(), type = "image/svg+xml") =>
  new Response(body, { headers: { "content-type": type } });
export const notFound = () => new Response("not found", { status: 404 });

export interface FakeExplorerOptions {
  /** Answer for an address; return nothing to fall through to the defaults below. */
  respond?: (url: string) => Response | undefined;
  /** Every request fails, as when the explorer cannot be reached. */
  down?: boolean;
}

/**
 * A pretend explorer.near-intents.org: by default a PNG for every token and an SVG for every network. Records every
 * request, so tests can say what the server asked for and with what limits.
 */
export function fakeExplorer(options: FakeExplorerOptions = {}) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (options.down) return new Response("down", { status: 503 });
    const custom = options.respond?.(url);
    if (custom) return custom;
    if (url.startsWith(`${EXPLORER}token/`)) return pngResponse();
    if (url.startsWith(`${EXPLORER}network/`)) return svgResponse();
    return notFound();
  });
  return { fetcher, calls, urls: () => calls.map((c) => c.url) };
}
