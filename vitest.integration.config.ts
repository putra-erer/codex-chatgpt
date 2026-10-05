import { mergeConfig, defineConfig } from "vitest/config";
import base from "./vitest.config";

export default mergeConfig(base, defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    exclude: [],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
}));
