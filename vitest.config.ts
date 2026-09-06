import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Exercise the shared application source in integration tests, rather than
  // its last compiled workspace copy. Build/typecheck retain package boundaries.
  resolve: { alias: [{ find: /^@benchledger\/application$/u, replacement: fileURLToPath(new URL("./packages/application/src/index.ts", import.meta.url)) }] },
  test: {
    include: ["apps/**/*.test.ts", "apps/**/*.test.tsx", "packages/**/*.test.ts"],
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
