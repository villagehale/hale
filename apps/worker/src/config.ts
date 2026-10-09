import { z } from 'zod';

/** An unset or blank URL is "not configured", not an invalid URL. */
function blankToUndefined(value: unknown): unknown {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Optional at import. The Next.js build loads the orchestrator (drain route)
  // while collecting page data, and a Vercel Preview build has no database URL
  // so it cannot reach production. Connecting still goes through requireDatabaseUrl.
  DATABASE_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_HOST: z.string().url().optional(),
  PORT: z.coerce.number().int().positive().default(4000),
  INTERNAL_API_SHARED_SECRET: z.string().min(16).optional(),
  /** Off by default: the Fake curated floor is the always-available provider.
   * When true, discovery uses the live web-grounded provider instead. */
  VILLAGE_WEB_GROUNDING: z.coerce.boolean().default(false),
});

export const config = envSchema.parse(process.env);
export type WorkerConfig = typeof config;

/** Worker boot, the pool, and the queue. Missing URL throws here, not at import. */
export function requireDatabaseUrl(): string {
  const url = config.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  return url;
}
