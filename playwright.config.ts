import { defineConfig } from "@playwright/test";

const port = 8794;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: `BENCHLEDGER_HOST=127.0.0.1 BENCHLEDGER_PORT=${port} node apps/server/dist/main.js --demo`,
    url: `http://127.0.0.1:${port}/api/v1/ready`,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
