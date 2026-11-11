import { createApp, bearerRecord } from "../../server/dist/app.js";

// Disposable in-memory data only; deliberately inaccessible from the LAN.
const token = "synthetic-mobile-token";
const app = await createApp({ demo: true, logger: false, auth: {
  sessionSecret: "synthetic-local-mobile-session-secret-48-characters",
  bearerTokens: [bearerRecord(token, ["read", "write"])]
} });
// BENCHLEDGER_MOBILE_DEMO_PORT picks another loopback port when 8796 is taken.
const port = Number(process.env.BENCHLEDGER_MOBILE_DEMO_PORT ?? 8796);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("BENCHLEDGER_MOBILE_DEMO_PORT must be a port from 1024 to 65535");
await app.listen({ host: "127.0.0.1", port });
console.log(`Synthetic mobile demo: http://127.0.0.1:${port}`);
console.log(`Demo API token: ${token}`);
console.log("Simulator only. Enable local HTTP in the app. Ctrl-C stops the demo.");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await app.close(); process.exit(0); });
