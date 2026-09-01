import { defineConfig } from 'vitest/config';

// Root-level runner for repo scripts only (scripts/ci/*). Package tests keep
// their own per-package vitest configs; this config must never include them.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.mjs'],
  },
});
