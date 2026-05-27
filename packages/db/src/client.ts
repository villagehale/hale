import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDb>;

interface CreateDbOptions {
  connectionString: string;
  /** max pool size; default 10 */
  max?: number;
  /** idle timeout in seconds; default 20 */
  idleTimeout?: number;
}

export function createDb(options: CreateDbOptions) {
  const client = postgres(options.connectionString, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 20,
    prepare: false,
  });

  return drizzle(client, { schema, casing: 'snake_case' });
}
