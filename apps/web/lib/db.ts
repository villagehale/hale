import { createDb, type Database } from '@hale/db';

let cached: Database | undefined;

export function db(): Database {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is not set');
    }
    // Chokepoint timeout defaults apply (5s connect, 10s statement — audit P1-9):
    // this ONE pool serves every web path, and its tightest consumer is the Twilio
    // inbound webhook's 15s budget, so the shared bounds are sized to the webhook
    // rather than to the roomiest cron. A cron path that ever legitimately needs a
    // longer statement passes statementTimeoutMs on its own pool — it does not
    // loosen this one.
    cached = createDb({ connectionString: url });
  }
  return cached;
}
