// Compiles src/ to dist/ and copies the SQL migrations next to the code that reads them. Used by `pnpm build` and the Dockerfile.
import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
execFileSync("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });
cpSync("src/db/migrations", "dist/db/migrations", { recursive: true });
console.log("Built the server into dist/.");
