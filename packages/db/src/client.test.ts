import { describe, expect, it } from 'vitest';
import { createDb } from './client.js';

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
