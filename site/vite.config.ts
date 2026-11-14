import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { applyLinks, parseLinks } from "./links.js";

/** Fill `{{github}}` and friends from links.json, and drop the buttons whose link does not exist yet. */
const links = (): Plugin => ({
  name: "tilll-site-links",
  transformIndexHtml: (html) =>
    applyLinks(html, parseLinks(JSON.parse(readFileSync(new URL("./links.json", import.meta.url), "utf8")))),
});

// The project site is built to static files in site/dist. Every URL in them is relative, so they work from any
// static host. The live demo serves them (see demo/ and Dockerfile.demo). Tilll itself does not.
export default defineConfig({
  root: "site",
  base: "./",
  plugins: [tailwindcss(), links()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        docs: fileURLToPath(new URL("./docs.html", import.meta.url)),
      },
    },
  },
});
