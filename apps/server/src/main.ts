import { createApp } from "./app.js";
import { bearerTokensFromEnvironment, secureCookiesFromEnvironment } from "./auth.js";
import { positiveIntegerFromEnvironment } from "./config.js";

const host = process.env.BENCHLEDGER_HOST ?? "127.0.0.1";
const port = Number(process.env.BENCHLEDGER_PORT ?? 8792);
const demo = process.env.BENCHLEDGER_DEMO === "true" || process.argv.includes("--demo");
const maxUploadBytes = positiveIntegerFromEnvironment(process.env, "BENCHLEDGER_MAX_UPLOAD_BYTES");
const maxStorageBytes = positiveIntegerFromEnvironment(process.env, "BENCHLEDGER_MAX_STORAGE_BYTES");
const adminPasswordHash = process.env.BENCHLEDGER_ADMIN_PASSWORD_HASH;

if (!demo && !process.env.BENCHLEDGER_DATA_DIR) {
  throw new Error("BENCHLEDGER_DATA_DIR must point to an external persistent data directory when demo mode is disabled");
}

const bearerTokens = demo ? [] : bearerTokensFromEnvironment();
const app = await createApp({
  demo,
  ...(process.env.BENCHLEDGER_DATA_DIR === undefined ? {} : { dataDir: process.env.BENCHLEDGER_DATA_DIR }),
  ...(maxUploadBytes === undefined ? {} : { maxUploadBytes }),
  ...(maxStorageBytes === undefined ? {} : { maxStorageBytes }),
  logger: true,
  trustProxy: process.env.BENCHLEDGER_TRUST_PROXY === "true",
  auth: {
    secureCookies: secureCookiesFromEnvironment(),
    ...(adminPasswordHash === undefined ? {} : { adminPasswordHash }),
    ...(bearerTokens.length === 0 ? {} : { bearerTokens })
  }
});
await app.listen({ host, port });

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down BenchLedger");
  try {
    await app.close();
  } catch (error: unknown) {
    app.log.error({ err: error }, "graceful shutdown failed");
    process.exitCode = 1;
  }
};

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
