import { createApp, bearerRecord } from "../../server/dist/app.js";

// Disposable in-memory data only; deliberately inaccessible from the LAN.
const token = "synthetic-mobile-token";
const app = await createApp({ demo: true, logger: false, auth: {
  sessionSecret: "synthetic-local-mobile-session-secret-48-characters",
  bearerTokens: [bearerRecord(token, ["read", "write"])]
} });
await app.listen({ host: "127.0.0.1", port: 8796 });
console.log("Synthetic mobile demo: http://127.0.0.1:8796");
console.log(`Demo API token: ${token}`);
console.log("Simulator only. Enable local HTTP in the app. Ctrl-C stops the demo.");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await app.close(); process.exit(0); });
