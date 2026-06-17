import postgres from 'postgres';

export interface WaitlistStore {
  add(email: string): Promise<{ created: boolean }>;
}

// The minimal db surface the store needs: insert one email, dedup on conflict,
// and report whether a new row was created. Injected so the store is testable
// without a live Postgres connection.
export interface WaitlistDb {
  insertEmail(email: string): Promise<{ created: boolean }>;
}

let cachedDb: WaitlistDb | undefined;

function resolveDb(): WaitlistDb {
  if (!cachedDb) cachedDb = dbFromEnv();
  return cachedDb;
}

function dbFromEnv(): WaitlistDb {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('waitlist store not configured: missing DATABASE_URL');
  }
  // prepare: false — Supabase's transaction pooler does not support prepared
  // statements (mirrors packages/db/src/client.ts).
  const sql = postgres(connectionString, { prepare: false });
  return {
    async insertEmail(email) {
      const rows = await sql<{ id: string }[]>`
        insert into waitlist (email)
        values (${email})
        on conflict (email) do nothing
        returning id
      `;
      return { created: rows.length > 0 };
    },
  };
}

// db is injected in tests; in production it is lazily created on first call so the
// build never needs a live connection. The cache keeps one pool per process.
export function createWaitlistStore(db?: WaitlistDb): WaitlistStore {
  return {
    async add(email) {
      return (db ?? resolveDb()).insertEmail(email);
    },
  };
}
