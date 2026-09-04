import { createDb, type Database } from '@hale/db';
import { config } from './config.js';

let cached: Database | undefined;

export function db(): Database {
  if (!cached) {
    // Long-lived batch runtime — no webhook waiting on this pool, so statements
    // get 60s (vs the web pool's 10s default; webhook paths tighter than cron
    // paths, audit P1-9). Still bounded: a hung statement here pins a drained
    // job, not nothing. Connect keeps the 5s chokepoint default.
    cached = createDb({ connectionString: config.DATABASE_URL, statementTimeoutMs: 60_000 });
  }
  return cached;
}
