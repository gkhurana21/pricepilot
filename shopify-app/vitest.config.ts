import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
    exclude: ["node_modules/**", "build/**", ".react-router/**", ".engine/**"],
    // Builds the real Go engine once; tests exercise the real binary.
    globalSetup: ["app/services/testing/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Each file gets its own temp SQLite database, but the engine build is shared.
    pool: "forks",
  },
});
