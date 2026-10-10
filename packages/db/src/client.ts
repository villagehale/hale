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
   * shared web pool is the Linq inbound webhook (15s total budget — see
   * linq/transport.ts): the driver's 30s default could legally spend
   * twice that budget on a connect that a healthy same-region pooler does in
   * milliseconds. A 5s-stuck connect is a brown-out; failing fast is what lets
   * the failure boundary 5xx while Linq still retries (2026-09-03 audit P1-9;
   * formerly Twilio).
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
  /**
   * Client-side bound in ms. The transaction pooler strips startup parameters,
   * and a session stuck in ClientRead is not running a statement, so
   * statement_timeout never starts. This timer cancels the query from the
   * client. Default 8s, the same budget an inbound reader gets.
   */
  queryTimeoutMs?: number;
}

/** Client gave up waiting. The statement may still be open until cancel lands. */
export class QueryTimeoutError extends Error {
  constructor() {
    super('query_timeout');
    this.name = 'QueryTimeoutError';
  }
}

/** Matches the inbound reader's per-call budget (channel/config.ts CALL_TIMEOUT_MS). */
export const QUERY_TIMEOUT_MS = 8_000;

/** 30 minutes. Explicit, so a connection cannot outlive a stuck turn by the
 * driver's random 30–60 minute default. */
const MAX_LIFETIME_SECONDS = 30 * 60;

/** A transaction left idle — not the ClientRead stall, which is `active` —
 * is cut here. Startup parameter, so the transaction pooler may strip it;
 * the client query timer above is the bound that still holds. */
const IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS = 15_000;

interface CancellableQuery {
  cancel: () => void;
  // postgres.js Query.then is the Promise overload. A structural match is
  // wider than that overload, which is what a fake in the unit test needs.
  // biome-ignore lint/suspicious/noExplicitAny: matches Promise.then's overload set
  then: (...args: any[]) => Promise<unknown>;
}

/**
 * Race a postgres.js query against a client timer. `.values()` / `.raw()`
 * return the same query and do not start it; `then` does. The timer is armed
 * only then, so drizzle's `.unsafe().values()` still switches the row mode
 * before the query is sent. A timeout calls `.cancel()` and rejects with
 * {@link QueryTimeoutError}. The original promise is caught so a late cancel
 * rejection is not unhandled.
 */
export function guardQuery<Q extends CancellableQuery>(query: Q, timeoutMs: number): Q {
  const originalThen = query.then.bind(query);
  // postgres.js Query is a Promise. The timer has to wrap then, which is what
  // starts the query; .values() returns the same object and does not.
  // biome-ignore lint/suspicious/noThenProperty: wrapping the driver's own then
  query.then = ((onFulfilled, onRejected) => {
    let settled = false;
    const pending = originalThen(
      (value: unknown) => value,
      (err: unknown) => {
        throw err;
      },
    );
    const raced = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          query.cancel();
        } catch {
          // Cancel is best-effort. The caller stops waiting either way.
        }
        const timeout = new QueryTimeoutError();
        if (onRejected) {
          try {
            resolve(onRejected(timeout));
          } catch (err) {
            reject(err);
          }
        } else {
          reject(timeout);
        }
      }, timeoutMs);
      pending.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            resolve(onFulfilled ? onFulfilled(value) : value);
          } catch (err) {
            reject(err);
          }
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (onRejected) {
            try {
              resolve(onRejected(err));
            } catch (error) {
              reject(error);
            }
          } else {
            reject(err);
          }
        },
      );
    });
    void pending.catch(() => {});
    return raced;
  }) as Q['then'];
  return query;
}

interface GuardableSql {
  unsafe: (...args: never[]) => CancellableQuery;
  begin?: (...args: never[]) => Promise<unknown>;
}

function installQueryGuard(sql: GuardableSql, timeoutMs: number): void {
  const originalUnsafe = sql.unsafe.bind(sql);
  sql.unsafe = ((...args: never[]) =>
    guardQuery(originalUnsafe(...args), timeoutMs)) as GuardableSql['unsafe'];

  const begin = sql.begin;
  if (typeof begin !== 'function') return;
  if ((begin as { __guarded?: boolean }).__guarded) return;
  const originalBegin = begin.bind(sql);
  const wrapped = ((...args: never[]) => {
    const list = args as unknown[];
    const last = list[list.length - 1];
    if (typeof last === 'function') {
      const fn = last as (tx: GuardableSql) => unknown;
      list[list.length - 1] = (tx: GuardableSql) => {
        installQueryGuard(tx, timeoutMs);
        return fn(tx);
      };
    }
    return originalBegin(...(list as never[]));
  }) as GuardableSql['begin'] & { __guarded?: boolean };
  wrapped.__guarded = true;
  sql.begin = wrapped;
}

/** date, time, timestamp, timestamptz — the oids drizzle/postgres-js makes transparent. */
const DATE_OIDS = [1082, 1083, 1114, 1184] as const;

export function createDb(options: CreateDbOptions) {
  // max_pipeline is honoured by postgres.js 3.4.5+ and missing from its
  // published Options type. It is read when each connection is constructed,
  // so it has to be on the object passed to postgres(), not set afterwards.
  //
  // 1 is the smallest limit at which sql.begin still reserves the
  // connection, and the limit that stops a pipeline from filling.
  // connection.js runs the reservation hook only when
  // `sent.length < max_pipeline`. The statement currently executing is not
  // in `sent`, so a limit of 0 skips the hook on every BEGIN.
  // CommandComplete then throws UNSAFE_TRANSACTION ("Only use sql.begin,
  // sql.reserved or max: 1") and every db.transaction fails — the reply is
  // already on the phone, and the ledger write never lands. With 1 the
  // active BEGIN reserves (`0 < 1`). Once one statement sits in `sent`,
  // `sent.length < 1` is false and the connection is marked full, so the
  // open-question readers cannot pile a hundred statements onto one
  // session the way the driver's default of 100 did. That pile-up is what
  // left Supavisor active/ClientRead with statement_timeout never started
  // (#732).
  const driverOptions = {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 20,
    prepare: false,
    connect_timeout: options.connectTimeoutSeconds ?? 5,
    max_pipeline: 1,
    max_lifetime: MAX_LIFETIME_SECONDS,
    connection: {
      statement_timeout: options.statementTimeoutMs ?? 10_000,
      idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
    },
  };
  const client = postgres(
    options.connectionString,
    driverOptions as unknown as postgres.Options<Record<string, postgres.PostgresType>>,
  );

  installQueryGuard(client as unknown as GuardableSql, options.queryTimeoutMs ?? QUERY_TIMEOUT_MS);

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
