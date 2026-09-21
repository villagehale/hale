import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    include: ['lib/**/*.test.ts', 'components/**/*.test.ts', 'app/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // PGlite + the full migration chain on a cold worker exceeds Vitest's 10s
    // default. createTestDb now clones a per-worker snapshot, but the first
    // boot still has to apply SQL, and CI has failed twice at exactly 10000ms.
    hookTimeout: 30_000,
    // Several worktrees run this suite at once on one machine (parallel makers and
    // verifiers). One fork per core times four concurrent runs put the load past 100 and
    // turned cold pglite boots into 5000 ms "flakes". CI has fewer cores than this cap.
    maxWorkers: 4,
  },
});
