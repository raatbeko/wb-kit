import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["mcp/**/tests/**/*.test.ts", "scripts/**/*.test.ts", "audit/**/*.test.ts", "competitors/**/*.test.ts"],
    testTimeout: 10000,
  },
});
