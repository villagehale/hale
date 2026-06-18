import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The React Email template (emails/*.tsx) is rendered through the route under
  // test, so the JSX transform must use React's automatic runtime — esbuild's
  // default is classic, which needs React in scope.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    include: ['lib/**/*.test.ts'],
  },
});
