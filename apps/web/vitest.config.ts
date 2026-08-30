import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "src/App.tsx",
        "src/main.tsx",
        "src/**/*.test.ts",
        "src/**/*.test.tsx"
      ],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 }
    }
  }
});
