import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'evals/**/*.test.mjs'],
    setupFiles: ['./vitest.setup.ts'],
    // PGlite's first boot applies the migration chain. The web suite already
    // raises this; the flags-on run timed out canary-family's beforeAll at
    // the 10s default while the same file finished in 9891ms on main.
    hookTimeout: 30_000,
  },
});
