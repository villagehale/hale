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
  /**
   * TCP+TLS connect bound in seconds; default 5. Client-enforced by postgres.js,
   * so it holds through the transaction pooler too. The tightest consumer of the
   * shared web pool is the Twilio inbound webhook (15s total budget — see
   * channel/twilio/transport.ts): the driver's 30s default could legally spend
   * twice that budget on a connect that a healthy same-region pooler does in
   * milliseconds. A 5s-stuck connect is a brown-out; failing fast is what lets
   * the failure boundary 5xx while Twilio still retries (2026-09-03 audit P1-9).
   */
  connectTimeoutSeconds?: number;
  /**
   * Per-statement server-side bound in ms, sent as a startup parameter; default
   * 10_000 (inside the webhook's 15s budget).
   *
   * HONESTY NOTE (probed live 2026-09-03): the Supabase TRANSACTION pooler
   * (:6543, prod DATABASE_URL) STRIPS startup parameters — through it the
   * operative statement bound is the server-side role default (`SHOW
   * statement_timeout` = 2min in prod), not this value. DIRECT connections
   * (:5432 — migrations, drift check, scripts, local dev) do honor it (probe:
   * SHOW returned 12s when set to 12000). So this is a real bound everywhere
   * except through the pooler; tightening the pooler path below 2min is a
   * server-side role setting, deliberately NOT smuggled into this client.
   */
  statementTimeoutMs?: number;
}

/** date, time, timestamp, timestamptz — the oids drizzle/postgres-js makes transparent. */
const DATE_OIDS = [1082, 1083, 1114, 1184] as const;

export function createDb(options: CreateDbOptions) {
  const client = postgres(options.connectionString, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 20,
    prepare: false,
    connect_timeout: options.connectTimeoutSeconds ?? 5,
    connection: {
      statement_timeout: options.statementTimeoutMs ?? 10_000,
    },
  });

  const db = drizzle(client, { schema, casing: 'snake_case' });

  // drizzle's postgres-js driver replaces the driver's date serializers with identity so
  // its column mappings own the formatting. A Date with no column to map through (a raw
  // `sql` fragment, an operator over a fragment) then reaches the byte writer unconverted
  // and the statement throws ERR_INVALID_ARG_TYPE before it is sent — pglite, a different
  // driver, never sees it. Every one of those Dates now goes out the way a mapped column
  // would send it.
  for (const oid of DATE_OIDS) {
    client.options.serializers[oid] = (value: unknown): string =>
      value instanceof Date ? value.toISOString() : (value as string);
  }

  return db;
}
