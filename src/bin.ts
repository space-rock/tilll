import { runTilll } from "./cli.js";

// Pick up settings from ./.env when it exists. Silent when it does not.
try {
  process.loadEnvFile(".env");
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}

process.exitCode = await runTilll(process.argv.slice(2), process.env, {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
});
