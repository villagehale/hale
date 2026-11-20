import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { resetPosthogClientsForTests } from './posthog-node';
import { resetProductCaptureLogsForTests } from './product';
import { UNANSWERED_ROUTE, sweepUnansweredMessages, unansweredAfterMs } from './unanswered';

describe('unansweredAfterMs', () => {
  it('defaults to 15 minutes and rejects non-positive values', () => {
    expect(unansweredAfterMs({})).toBe(15 * 60_000);
    expect(unansweredAfterMs({ POSTHOG_UNANSWERED_AFTER_MINUTES: '20' })).toBe(20 * 60_000);
    expect(unansweredAfterMs({ POSTHOG_UNANSWERED_AFTER_MINUTES: '0' })).toBe(15 * 60_000);
  });
});

describe('sweepUnansweredMessages', () => {
  let db: TestDb;
  let familyId: string;
  let parentUserId: string;

  beforeEach(async () => {
    db = await createTestDb();
    ({ familyId, parentUserId } = await seedFamily(db.database));
    vi.stubEnv('POSTHOG_ERROR_TRACKING_ENABLED', 'true');
    vi.stubEnv('POSTHOG_ID_SALT', 'test-salt');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_product_test');
    vi.stubEnv('POSTHOG_HOST', 'https://ph.example.com');
    resetPosthogClientsForTests();
    resetProductCaptureLogsForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetPosthogClientsForTests();
    await db.close();
  });

  async function inbound(at: Date, providerId: string): Promise<string> {
    const [row] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId,
        channel: 'imessage',
        direction: 'in',
        category: 'reply',
        providerMessageId: providerId,
        status: 'delivered',
        inGroup: false,
        createdAt: at,
        sentAt: at,
      })
      .returning({ id: schema.channelMessages.id });
    if (!row) throw new Error('inbound insert returned no row');
    return row.id;
  }

  it('is a no-op when the error-tracking flag is off', async () => {
    vi.stubEnv('POSTHOG_ERROR_TRACKING_ENABLED', '');
    const now = new Date('2026-11-10T12:00:00.000Z');
    await inbound(new Date(now.getTime() - 20 * 60_000), 'in-1');
    await expect(sweepUnansweredMessages(db.database, now)).resolves.toEqual({
      scanned: 0,
      emitted: 0,
      skipped: 'flag_off',
    });
  });

  it('emits once for an inbound with no sms_turn_answered, then claims so a re-tick is quiet', async () => {
    const now = new Date('2026-11-10T12:00:00.000Z');
    const id = await inbound(new Date(now.getTime() - 20 * 60_000), 'in-stale');
    const first = await sweepUnansweredMessages(db.database, now);
    expect(first.skipped).toBeNull();
    expect(first.emitted).toBe(1);
    const claims = await db.database
      .select({ identifier: schema.rateLimits.identifier })
      .from(schema.rateLimits)
      .where(eq(schema.rateLimits.route, UNANSWERED_ROUTE));
    expect(claims.map((row) => row.identifier)).toEqual([id]);
    const second = await sweepUnansweredMessages(db.database, now);
    expect(second.emitted).toBe(0);
  });

  it('does not emit when the turn was answered', async () => {
    const now = new Date('2026-11-10T12:00:00.000Z');
    const id = await inbound(new Date(now.getTime() - 20 * 60_000), 'in-answered');
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'sms_turn_answered',
      targetTable: 'channel_messages',
      targetId: id,
    });
    await expect(sweepUnansweredMessages(db.database, now)).resolves.toMatchObject({
      emitted: 0,
      skipped: null,
    });
  });
});
