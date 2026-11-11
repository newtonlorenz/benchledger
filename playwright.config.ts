import { defineConfig, devices } from "@playwright/test";

// Override with BENCHLEDGER_E2E_PORT / BENCHLEDGER_E2E_MOBILE_PORT when the
// defaults are taken by another local service.
const port = Number(process.env.BENCHLEDGER_E2E_PORT ?? 8794);
// The mobile smoke project gets its own demo server so its writes never
// interact with the order-dependent desktop suite (see docs/development-workflow.md).
const mobilePort = Number(process.env.BENCHLEDGER_E2E_MOBILE_PORT ?? 8795);
const ci = Boolean(process.env.CI);

function demoServer(serverPort: number) {
  return {
    command: `BENCHLEDGER_HOST=127.0.0.1 BENCHLEDGER_PORT=${serverPort} node apps/server/dist/main.js --demo`,
    url: `http://127.0.0.1:${serverPort}/api/v1/ready`,
    reuseExistingServer: false,
    timeout: 120_000
  };
}

export default defineConfig({
  testDir: "./e2e",
  // Specs share one in-memory demo workspace and rely on file-name ordering,
  // so the desktop suite stays serial on a single worker.
  fullyParallel: false,
  workers: 1,
  // One CI retry absorbs infrastructure flake; the retry records a trace.
  retries: ci ? 1 : 0,
  forbidOnly: ci,
  reporter: ci
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }], ["junit", { outputFile: "playwright-report/junit.xml" }]]
    : [["list"]],
  use: {
    trace: ci ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port}` }
    },
    {
      // A small read-mostly smoke subset at phone size. Many desktop specs
      // already resize to 390px; this project checks real mobile emulation
      // (touch, mobile user agent, device scale factor) without doubling the run.
      name: "mobile-chromium-smoke",
      testMatch: /zzzzzz-professional-smoke\.spec\.ts$/u,
      grep: /an unavailable project link never opens an unrelated project/u,
      use: { ...devices["Pixel 7"], baseURL: `http://127.0.0.1:${mobilePort}` }
    }
  ],
  webServer: [demoServer(port), demoServer(mobilePort)]
});
