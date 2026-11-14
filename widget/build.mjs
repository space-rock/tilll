// Bundle the checkout widget (and the qrcode library it uses) into one file the server hands out as /checkout.js.
import { mkdirSync } from "node:fs";
import { build } from "esbuild";

mkdirSync("public", { recursive: true });

const result = await build({
  entryPoints: ["widget/src/checkout.ts"],
  outfile: "public/checkout.js",
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`public/checkout.js  ${(bytes / 1024).toFixed(1)} kB`);
