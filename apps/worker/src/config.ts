import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_HOST: z.string().url().optional(),
  PORT: z.coerce.number().int().positive().default(4000),
  INTERNAL_API_SHARED_SECRET: z.string().min(16).optional(),
});

export const config = envSchema.parse(process.env);
export type WorkerConfig = typeof config;
