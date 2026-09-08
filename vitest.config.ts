import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Full replay matrices are CPU-heavy; bound contention without extending test deadlines.
    maxWorkers: 4,
  },
});
