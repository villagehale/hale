import { createDb, type Database } from '@hale/db';
import { config } from './config.js';

let cached: Database | undefined;

export function db(): Database {
  if (!cached) {
    cached = createDb({ connectionString: config.DATABASE_URL });
  }
  return cached;
}
