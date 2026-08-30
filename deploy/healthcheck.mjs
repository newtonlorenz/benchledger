import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export async function checkHealth(fetchImpl = fetch, env = process.env) {
  const port = env.BENCHLEDGER_PORT ?? "8792";
  const response = await fetchImpl(`http://127.0.0.1:${port}/api/v1/health`);
  if (!response.ok) throw new Error(`BenchLedger health check failed: ${response.status}`);
  return true;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await checkHealth();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "BenchLedger health check failed");
    process.exitCode = 1;
  }
}
