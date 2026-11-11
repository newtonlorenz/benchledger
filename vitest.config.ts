import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Exercise the shared application source in integration tests, rather than
  // its last compiled workspace copy. Build/typecheck retain package boundaries.
  resolve: { alias: [{ find: /^@benchledger\/application$/u, replacement: fileURLToPath(new URL("./packages/application/src/index.ts", import.meta.url)) }, { find: /^@benchledger\/mcp$/u, replacement: fileURLToPath(new URL("./apps/mcp/src/index.ts", import.meta.url)) }] },
  test: {
    include: ["apps/**/*.test.ts", "apps/**/*.test.tsx", "packages/**/*.test.ts", "scripts/**/*.test.mjs"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80
      },
      include: [
        "apps/mcp/src/**/*.ts",
        "apps/server/src/**/*.ts",
        "apps/web/src/**/*.ts",
        "apps/web/src/**/*.tsx",
        "apps/mobile/src/client.ts",
        "apps/mobile/src/connection.ts",
        "apps/mobile/src/demo.ts",
        "apps/mobile/src/presentation.ts",
        "apps/mobile/src/query-cache.ts",
        "apps/mobile/src/use-remote.ts",
        "apps/mobile/src/session-controller.ts",
        "apps/mobile/src/tolerant.ts",
        "apps/mobile/src/links.ts",
        "apps/mobile/src/item-editor.ts",
        "apps/mobile/src/foreground.ts",
        "apps/mobile/src/error-boundary.tsx",
        "packages/api-contract/src/**/*.ts",
        "packages/application/src/**/*.ts",
        "packages/artifacts/src/**/*.ts",
        "packages/database/src/**/*.ts",
        "packages/domain/src/**/*.ts",
        "packages/importers/src/**/*.ts",
        "packages/runtime/src/**/*.ts"
      ],
      exclude: [
        "apps/server/src/main.ts",
        // App.tsx and main.tsx are browser lifecycle/bootstrap surfaces. Their
        // DOM focus behavior is covered by Playwright. Focused workflow component
        // tests opt into jsdom; other unit suites retain the Node environment.
        "apps/web/src/App.tsx",
        "apps/web/src/main.tsx",
        "**/*.test.ts",
        "**/*.test.tsx"
      ]
    }
  }
});
