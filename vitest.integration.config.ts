import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/integration/**/*.test.ts"],
    exclude: [],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
