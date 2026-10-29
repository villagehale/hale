import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { PostgresRateLimiter } from './postgres';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe('PostgresRateLimiter — firstDenied (VIL-463)', () => {
  it('is true only on the first refused request of a window', async () => {
    const limiter = new PostgresRateLimiter(db.database);
    const opts = { limit: 2, windowSec: 3600 };
    const seen = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await limiter.check('parent-1', 'sms-agent-turn', opts);
      seen.push([r.allowed, r.firstDenied]);
    }
    expect(seen).toEqual([
      [true, false],
      [true, false],
      [false, true],
      [false, false],
    ]);
  });
});
