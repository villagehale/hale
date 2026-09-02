import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'evals/**/*.test.mjs'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
