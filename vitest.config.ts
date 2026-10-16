import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so tests do not start the Cloudflare dev plugin.
export default defineConfig({
  test: { include: ["src/**/*.test.ts", "tests/**/*.test.ts"], passWithNoTests: true },
});
