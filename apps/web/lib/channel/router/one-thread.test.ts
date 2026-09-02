import { schema } from '@hale/db';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import type { ChannelMessageReceivedJob } from '~/lib/channel/twilio/inbound';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { loadReconcileView } from '~/lib/channel/reconcile/view';
import { createDisambiguationStore } from './disambiguation';
import { FakeReplyTransport } from './reply-route';
import type { ChannelCoachRuntime, ChannelRouterDeps } from './route';
import { routeChannelMessage } from './route';
import { auditSmokeAlarmClaim, auditTurnLedger, loadInboundContext } from './wiring';

/**
 * TEXT + EMAIL, ONE THREAD, ONE MEMORY — the journey, against a real Postgres.
 *
 * Everything else in this folder tests the router with the context read stubbed out.
 * This runs the REAL one, which is where the whole claim lives: `loadInboundContext`
 * reads the channel off the ledger row, resolves a route for THAT channel, and the
 * thread it opens is anchored to the parent rather than to the door. A stub cannot prove
 * any of that — it would return whatever route the test handed it, including the wrong
 * one, and the conversation key would be whatever the router happened to compute.
 *
 * The two messages below are the actual product promise: a parent texts, then emails,
 * and the second turn's coach reads the first turn back out of the same conversation.
 */

const NOW = new Date('2026-08-12T12:00:00.000Z');
const PHONE = '+14165551234';
const EMAIL = 'sam@example.com';

describe('one parent, two doors, one conversation', () => {
  let db: TestDb;
  let familyId: string;
  let parentUserId: string;
  let transport: FakeReplyTransport;
  /** What the coach was shown, per turn — the memory assertion reads this. */
  let transcripts: string[][];

  beforeEach(async () => {
    db = await createTestDb();
    vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Test Family', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    if (!family) throw new Error('no family');
    familyId = family.id;
    const [user] = await db.database
      .insert(schema.users)
      .values({ email: EMAIL, name: 'Sam' })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('no user');
    parentUserId = user.id;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: parentUserId, role: 'primary_parent' });
    await db.database.insert(schema.parentChannels).values({
      familyId,
      userId: parentUserId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: NOW,
    });
    transport = new FakeReplyTransport();
    transcripts = [];
  });

  afterEach(async () => {
    await db.close();
    vi.unstubAllEnvs();
  });

  /** A coach that answers with a fixed line and records the thread it was given. */
  function coach(reply: string): ChannelCoachRuntime {
    return {
      async respond(turn) {
        const rows = await db.database
          .select({ content: schema.messages.content })
          .from(schema.messages)
          .where(eq(schema.messages.conversationId, turn.conversationId))
          .orderBy(asc(schema.messages.createdAt));
        transcripts.push(rows.map((row) => row.content));
        return { reply, planOffer: null, activityPromise: null };
      },
    };
  }

  function deps(reply: string): ChannelRouterDeps {
    return {
      database: db.database,
      loadContext: loadInboundContext,
      transport,
      handlers: [],
      offDomain: { consider: async () => ({ status: 'in_domain', fallback: null }) },
      coach: coach(reply),
      smokeAlarm: auditSmokeAlarmClaim(db.database),
      turns: auditTurnLedger(db.database),
      apology: { compose: async () => ({ status: 'composed', reply: 'sorry' }) },
      recordPlanOffer: async () => ({ status: 'recorded' }),
      recordActivityPromise: async () => ({
        status: 'recorded',
        commitmentId: '77777777-7777-4777-8777-777777777777',
      }),
      // The stages beside the thread: nothing is open, nothing was stated, nothing is
      // owed — this journey is about the doors and the memory, not the ledgers. The
      // disambiguation store is the REAL one over the same Postgres, like the context
      // read: its pending() runs on every turn, so a stub here would skip a real query
      // the deployed router makes.
      questions: { open: async () => [] },
      replyResolver: { read: async () => ({ status: 'unresolved', reason: 'no_target' }) },
      disambiguation: createDisambiguationStore(),
      reconcileView: loadReconcileView,
      recordStatedState: async () => ({ status: 'nothing_stated' }),
      recordRegistrationWatch: async () => ({ status: 'recorded' }),
      dispatchDeepResearch: async () => ({ status: 'enqueued' }),
      limiter: new FakeRateLimiter(() => NOW.getTime()),
      now: () => NOW,
      log: { info: () => {}, error: () => {} },
    };
  }

  /** File an inbound the way its webhook does, and hand back C1's job for it. */
  async function inbound(
    channel: 'sms' | 'email',
    body: string,
    providerMessageId: string,
  ): Promise<ChannelMessageReceivedJob> {
    const [row] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId,
        channel,
        direction: 'in',
        category: 'reply',
        providerMessageId,
        status: 'delivered',
        body,
        sentAt: NOW,
      })
      .returning({ id: schema.channelMessages.id });
    if (!row) throw new Error('inbound: insert returned no row');
    return {
      family_id: familyId,
      parent_user_id: parentUserId,
      channel_message_id: row.id,
      provider_message_id: providerMessageId,
      received_at: NOW.toISOString(),
    };
  }

  it('answers each message on its own channel and remembers the other one', async () => {
    const texted = await inbound('sms', 'is the splash pad open saturday?', 'SM1');
    const first = await routeChannelMessage(deps('Yes — from 10.'), texted);

    const emailed = await inbound('email', 'and what about sunday?', '<msg-1@example.com>');
    const second = await routeChannelMessage(deps('Sunday it opens at 11.'), emailed);

    expect([first.status, second.status]).toEqual(['agent_replied', 'agent_replied']);

    // ONE conversation, and the second turn read the first one back out of it.
    expect(first.conversationId).toBe(second.conversationId);
    expect(transcripts[1]).toEqual([
      'is the splash pad open saturday?',
      'Yes — from 10.',
      'and what about sunday?',
    ]);

    // Each answer left by the door its question came through — the text to the verified
    // number, the email to the account address, threaded onto the inbound Message-ID.
    expect(transport.sent).toEqual([
      { route: { channel: 'sms', to: PHONE }, body: 'Yes — from 10.' },
      {
        route: { channel: 'email', to: EMAIL, inReplyTo: '<msg-1@example.com>' },
        body: 'Sunday it opens at 11.',
      },
    ]);
  });

  it('opens the thread under the parent anchor, whichever door came first', async () => {
    const emailed = await inbound('email', 'hi', '<msg-2@example.com>');
    await routeChannelMessage(deps('Hello.'), emailed);

    const conversations = await db.database
      .select({ noteKey: schema.conversations.noteKey })
      .from(schema.conversations);
    expect(conversations).toEqual([{ noteKey: channelSmsNoteKey(parentUserId) }]);
  });

  it('goes silent on an email from a parent who has stopped email, and says so', async () => {
    for (const emailType of ['daily_digest', 'weekly_plan', 'reminder', 'approval', 'alert'] as const) {
      await db.database.insert(schema.emailOptOuts).values({ userId: parentUserId, emailType });
    }

    const emailed = await inbound('email', 'anything on this week?', '<msg-3@example.com>');
    const result = await routeChannelMessage(deps('Plenty.'), emailed);

    expect(result.status).toBe('unreachable');
    expect(transport.sent).toEqual([]);
    // The positive control: the SAME parent is still reachable by text, so the silence
    // above is the opt-out doing its job rather than a lookup that matched nothing.
    const texted = await inbound('sms', 'anything on this week?', 'SM2');
    await routeChannelMessage(deps('Swim at 10 on Saturday.'), texted);
    expect(transport.sent).toEqual([
      { route: { channel: 'sms', to: PHONE }, body: 'Swim at 10 on Saturday.' },
    ]);
  });
});
