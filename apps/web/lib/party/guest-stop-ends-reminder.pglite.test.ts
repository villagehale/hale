import { schema } from '@hale/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type InboundRouteDeps, routeInboundText } from '~/lib/channel/inbound-route';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
} from '~/lib/channel/intake/fakes';
import type { IntakeDeps } from '~/lib/channel/intake/machine';
import type { OptOutReading } from '~/lib/channel/intake/opt-out-reader';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { defaultPartyReminderDeps, runPartyReminderCron } from './reminders';
import { submitRsvp } from './store';

/**
 * The RSVP page promises that a guest who replies and asks Hale to stop texting them ends
 * the reminder. The reader is a fake at its port (rule #8): this pins everything after a
 * stop reading, through the real inbound route, handleStop and the reminder sweep.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const STOPPING_GUEST = '+14165550142';
const OTHER_GUEST = '+14165550143';
const NOW = new Date('2026-11-20T15:30:00.000Z');
const PARTY_AT = new Date('2026-11-21T19:00:00.000Z');
const CONFIRMATION = 'Got it, I will not text you again.';
const STOP: OptOutReading = { intent: 'stop', confirmation: CONFIRMATION, language: 'en' };

let db: TestDb;

beforeAll(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('F14_ENABLED', 'true');
  db = await createTestDb();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.close();
});

function routeDeps(transport: FakeTransport): InboundRouteDeps {
  const intake: IntakeDeps = {
    transport,
    threadMessage: async () => 'conv-1',
    openQuestions: fakeNoOpenQuestions,
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([]),
    radar: fakeRadar,
    answerComposer: fakeSilentAnswerComposer,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => NOW.getTime()),
    optOutReader: { read: async () => STOP },
    now: NOW,
  };
  return {
    database: db.database,
    intake: () => intake,
    enqueue: async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    countOutcome: async () => {},
    now: () => NOW,
  };
}

describe('a stop reading from a party guest', () => {
  it('ends that guest reminder and leaves the other guest reminded', async () => {
    const host = await seedFamily(db.database, 'Host');
    await db.database.execute(
      sql`update users set timezone = 'America/Toronto' where id = ${host.parentUserId}`,
    );
    const [event] = await db.database
      .insert(schema.familyEvents)
      .values({ familyId: host.familyId, title: 'Party', startsAt: PARTY_AT, source: 'parent' })
      .returning({ id: schema.familyEvents.id });
    const [invite] = await db.database
      .insert(schema.partyInvites)
      .values({
        familyId: host.familyId,
        familyEventId: event?.id as string,
        hostUserId: host.parentUserId,
        publicToken: 'guest-stop-token',
      })
      .returning({ id: schema.partyInvites.id });
    const target = { inviteId: invite?.id as string, familyId: host.familyId, cancelled: false };
    for (const [displayName, reminderPhone] of [
      ['Stopping', STOPPING_GUEST],
      ['Other', OTHER_GUEST],
    ] as const) {
      await submitRsvp(
        db.database,
        target,
        { displayName, response: 'yes', headcount: 1, reminderPhone },
        NOW,
      );
    }

    const replyTransport = new FakeTransport();
    await routeInboundText(
      routeDeps(replyTransport),
      replyTransport.inbound(STOPPING_GUEST, 'please stop texting me', {
        providerId: 'pm-guest-stop',
        receivedAt: NOW,
        transport: 'imessage',
        chatId: 'chat-guest',
        isGroup: false,
      }),
    );

    expect(replyTransport.bodies()).toEqual([CONFIRMATION]);
    const [stopped] = await db.database
      .select({
        response: schema.partyRsvps.response,
        optIn: schema.partyRsvps.reminderOptInAt,
        encrypted: schema.partyRsvps.phoneE164Encrypted,
        hash: schema.partyRsvps.phoneE164Hash,
      })
      .from(schema.partyRsvps)
      .where(eq(schema.partyRsvps.displayName, 'Stopping'));
    expect(stopped).toEqual({ response: 'yes', optIn: null, encrypted: null, hash: null });

    const sweepTransport = new FakeTransport();
    const swept = await runPartyReminderCron(
      db.database,
      { ...defaultPartyReminderDeps(), transport: sweepTransport },
      NOW,
    );
    expect(swept.sent).toBe(1);
    expect(sweepTransport.sent.map((message) => message.to)).toEqual([OTHER_GUEST]);
  });
});
