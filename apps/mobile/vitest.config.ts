import { defineConfig } from 'vitest/config';

/**
 * Pure-logic tests only. React Native components aren't render-tested here (no
 * native runtime), so this scopes to the framework-free modules under src/lib —
 * the same per-package vitest pattern the rest of the monorepo uses.
 */
export default defineConfig({
  test: {
    include: ['src/lib/**/*.test.ts'],
  },
});
