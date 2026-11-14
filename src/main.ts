import { startTilll, startupErrorMessage } from "./start.js";

// Pick up settings from ./.env when it exists. Silent when it does not.
try {
  process.loadEnvFile(".env");
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}

try {
  const tilll = await startTilll(process.env, {
    logger: { level: "info", redact: ["req.headers.authorization"] },
    syncIcons: true,
    log: (line) => console.log(line),
  });
  console.log(`Tilll is listening on ${tilll.url}`);

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    await tilll.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
} catch (e) {
  const message = startupErrorMessage(e);
  if (!message) throw e;
  console.error(message);
  process.exit(1);
}
