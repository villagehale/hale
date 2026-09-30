import { describe, expect, it, vi } from 'vitest';
import { QUERY_TIMEOUT_MS, QueryTimeoutError, createDb, guardQuery } from './client.js';

/**
 * Timeout discipline at the ONE postgres() chokepoint (2026-09-03 SMS audit P1-9):
 * a slow-not-down DB must not be able to wall a serverless function silently —
 * the tightest consumer of the shared web pool is the Twilio inbound webhook,
 * whose whole budget is 15s. VIL-331 made DB-down loud; these bounds are for
 * DB-slow. Constructing the client without them is the regression this test
 * exists to catch.
 *
 * postgres.js is lazy — no connection is opened here; the assertions read the
 * options the driver actually parsed (`$client.options`), so a bound that never
 * reaches the driver fails the test.
 */
describe('createDb timeout discipline (audit P1-9)', () => {
  const url = 'postgres://user:pass@db.invalid:5432/hale';

  it('bounds connect (client-enforced everywhere, pooler included)', () => {
    const db = createDb({ connectionString: url });
    // 5s default: a healthy same-region pooler connects in milliseconds, and the
    // driver default of 30s is twice the entire webhook budget.
    expect(db.$client.options.connect_timeout).toBe(5);
  });

  it('declares statement_timeout as a startup parameter', () => {
    const db = createDb({ connectionString: url });
    expect(db.$client.options.connection.statement_timeout).toBe(10_000);
  });

  it('does not pipeline, and bounds lifetime and idle transactions', () => {
    const db = createDb({ connectionString: url });
    // 0: one query in flight per connection. The 17 open-question readers used
    // to pipeline onto one session; Postgres finished the check-in select and
    // waited in ClientRead while the client waited on the rest.
    expect((db.$client.options as { max_pipeline?: number }).max_pipeline).toBe(0);
    expect(db.$client.options.max_lifetime).toBe(30 * 60);
    expect(db.$client.options.connection.idle_in_transaction_session_timeout).toBe(15_000);
  });

  it('per-site overrides reach the driver', () => {
    const db = createDb({
      connectionString: url,
      connectTimeoutSeconds: 10,
      statementTimeoutMs: 60_000,
    });
    expect(db.$client.options.connect_timeout).toBe(10);
    expect(db.$client.options.connection.statement_timeout).toBe(60_000);
  });
});

describe('guardQuery', () => {
  it('cancels a query that does not settle and rejects by name', async () => {
    vi.useFakeTimers();
    const query = {
      cancel: vi.fn(),
      // biome-ignore lint/suspicious/noThenProperty: stand-in for a postgres.js Query
      then(onFulfilled?: (value: unknown) => unknown, onRejected?: (err: unknown) => unknown) {
        return new Promise((resolve, reject) => {
          query.settle = (err?: unknown) => {
            if (err === undefined) resolve(onFulfilled ? onFulfilled('row') : 'row');
            else if (onRejected) resolve(onRejected(err));
            else reject(err);
          };
        });
      },
      settle: (_err?: unknown) => {},
    };
    const guarded = guardQuery(query, QUERY_TIMEOUT_MS);
    const pending = Promise.resolve(guarded).then(
      () => 'resolved',
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(QUERY_TIMEOUT_MS);
    await expect(pending).resolves.toBeInstanceOf(QueryTimeoutError);
    expect(query.cancel).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('returns a fast query without cancelling it', async () => {
    const query = {
      cancel: vi.fn(),
      // biome-ignore lint/suspicious/noThenProperty: stand-in for a postgres.js Query
      then(onFulfilled?: (value: unknown) => unknown) {
        return Promise.resolve('ok').then(onFulfilled);
      },
    };
    await expect(guardQuery(query, QUERY_TIMEOUT_MS)).resolves.toBe('ok');
    expect(query.cancel).not.toHaveBeenCalled();
  });
});

/**
 * A JS Date that reaches postgres.js WITHOUT a column to map through — a raw `sql`
 * fragment, or an operator whose left side is a fragment (`gte(sql`coalesce(...)`, now)`)
 * — must arrive as an ISO string. drizzle's postgres-js driver installs IDENTITY
 * serializers for the date/time oids so its column mappings own the formatting, and
 * the driver's byte writer then throws ERR_INVALID_ARG_TYPE on the Date. pglite never
 * sees this (a different driver), which is how the inbound SMS lane shipped down on
 * 2026-09-08 (#617's anchor comparison) and stayed down until 2026-09-09.
 */
describe('Date parameters reach postgres.js as ISO strings (2026-09-09 inbound outage)', () => {
  const url = 'postgres://user:pass@db.invalid:5432/hale';
  const iso = '2026-09-09T02:57:07.421Z';

  it.each([1082, 1083, 1114, 1184])(
    'oid %i: a raw Date is serialized, a column-mapped string passes through',
    (oid) => {
      const serialize = createDb({ connectionString: url }).$client.options.serializers[oid];
      if (!serialize) throw new Error(`no serializer registered for oid ${oid}`);
      expect(serialize(new Date(iso))).toBe(iso);
      expect(serialize(iso)).toBe(iso);
    },
  );

  it('leaves the json passthrough drizzle relies on untouched', () => {
    const { serializers } = createDb({ connectionString: url }).$client.options;
    for (const oid of [114, 3802]) {
      const passthrough = serializers[oid];
      if (!passthrough) throw new Error(`no serializer registered for oid ${oid}`);
      expect(passthrough('{"a":1}')).toBe('{"a":1}');
    }
  });
});
