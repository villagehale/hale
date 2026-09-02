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
      // The Next plugin aliases `next-intl/config` to i18n/request.ts at build
      // time; vitest needs the same alias so getTranslations({locale}) resolves
      // the request config (and thus the message bundles) under test.
      'next-intl/config': fileURLToPath(new URL('./i18n/request.ts', import.meta.url)),
    },
  },
  test: {
    // next-intl ships ESM-only and Next.js deoptimizes its resolution; inlining
    // lets vitest process it. https://github.com/vercel/next.js/issues/77200
    server: { deps: { inline: ['next-intl'] } },
    include: ['lib/**/*.test.ts', 'components/**/*.test.ts', 'app/**/*.test.ts'],
  },
});
