import { createDb, type Database } from '@hearth/db';

let cached: Database | undefined;

export function db(): Database {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is not set');
    }
    cached = createDb({ connectionString: url });
  }
  return cached;
}
