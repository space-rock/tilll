/** The links that only exist once the project is published (PLAN section 21: filled in at Phase 9). */
export interface SiteLinks {
  /** The public repository, for example `https://github.com/owner/tilll`. Null until it is public. */
  github: string | null;
  /** The demo video. Null until it is recorded. */
  demoVideo: string | null;
  /** The live demo shop, running on real payments. Null until it is deployed. */
  liveDemo: string | null;
}

const HTTPS_URL = /^https:\/\/[^\s"'<>]+$/;

/** Read `links.json`. A link must be https (never `javascript:` or anything else) or null. */
export function parseLinks(raw: unknown): SiteLinks {
  const value = (raw ?? {}) as Record<string, unknown>;
  const read = (name: "github" | "demoVideo" | "liveDemo"): string | null => {
    const link = value[name];
    if (link === null || link === undefined) return null;
    if (typeof link !== "string" || !HTTPS_URL.test(link))
      throw new Error(`site/links.json: "${name}" must be an https URL or null.`);
    return link.replace(/\/+$/, "");
  };
  return { github: read("github"), demoVideo: read("demoVideo"), liveDemo: read("liveDemo") };
}

const NEEDS: Record<string, keyof SiteLinks> = { github: "github", demoVideo: "demoVideo", liveDemo: "liveDemo" };

/**
 * Fill the page's link placeholders. An element marked `data-needs="github"` (`demoVideo` or `liveDemo`) is removed when that link
 * does not exist yet, so the page never shows a button that goes nowhere. `{{github}}`, `{{demoVideo}}` and
 * `{{cloneTarget}}` are replaced; any other `{{...}}` left over is a mistake and fails the build.
 */
export function applyLinks(html: string, links: SiteLinks): string {
  let out = html.replace(
    /<(a|li|span)\b[^>]*\bdata-needs="(\w+)"[^>]*>[\s\S]*?<\/\1\s*>\s*/g,
    (element, _tag, needs: string) => {
      const key = NEEDS[needs];
      if (!key) throw new Error(`index.html: unknown data-needs="${needs}".`);
      // Kept: the marker has done its job.
      return links[key] ? element.replace(/\sdata-needs="\w+"/, "") : "";
    },
  );
  out = out
    .replaceAll("{{github}}", links.github ?? "")
    .replaceAll("{{demoVideo}}", links.demoVideo ?? "")
    .replaceAll("{{liveDemo}}", links.liveDemo ?? "")
    // Share cards need an absolute image URL. The live demo serves the site, so its origin is the site's.
    .replaceAll("{{siteUrl}}", links.liveDemo ? new URL(links.liveDemo).origin : ".")
    .replaceAll("{{cloneTarget}}", links.github ?? "&lt;repository-url&gt;");
  const left = /\{\{[^}]*\}\}/.exec(out);
  if (left) throw new Error(`index.html: unfilled placeholder ${left[0]}.`);
  return out;
}
