import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_DIRECT_URL or DATABASE_URL must be set for migrations');
}

export default defineConfig({
  // Point at the compiled output, not src: the schema uses ESM '.js' import
  // specifiers (./users.js) that resolve against .ts only under a bundler;
  // drizzle-kit's CJS loader can't map them, so it needs the emitted .js.
  // Run `pnpm --filter @hearth/db build` before generate/migrate/push.
  schema: './dist/schema/index.js',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
