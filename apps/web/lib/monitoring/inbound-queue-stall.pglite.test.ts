import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INBOUND_TURN_QUEUES } from '~/lib/channel/config';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { INBOUND_QUEUE_UNREADABLE, loadInboundQueueStall } from './inbound-queue-stall';

/**
 * A Hale-only database has no pg-boss schema, so the read fails the way a real
 * missing or unreachable `pgboss.job` does. The driver error carries the SQL text
 * and its bound parameters; the log must carry only the error's class.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe('loadInboundQueueStall when pgboss.job cannot be read', () => {
  it('the driver error itself carries the statement and its parameters', async () => {
    const thrown = await db.client
      .query('select count(*) from pgboss.job where name = $1', [INBOUND_TURN_QUEUES[0]])
      .catch((err: unknown) => err);
    expect(thrown).toMatchObject({
      code: '42P01',
      query: expect.stringContaining('pgboss.job'),
      params: [INBOUND_TURN_QUEUES[0]],
    });
  });

  it('names it unreadable and logs only the error code and name', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const snapshot = await loadInboundQueueStall(db.database);

    expect(snapshot).toEqual(INBOUND_QUEUE_UNREADABLE);
    expect(error.mock.calls).toEqual([
      ['ops daily: inbound queue unreadable', { code: '42P01', name: 'error' }],
    ]);
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toMatch(/pgboss|select|count\(/i);
    for (const queue of INBOUND_TURN_QUEUES) expect(logged).not.toContain(queue);
    error.mockRestore();
  });
});
