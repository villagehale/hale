import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { OptOutReadInput, OptOutReading } from '~/lib/channel/intake/opt-out-reader';
import { recoverHeldOptOutReads } from '~/lib/channel/intake/opt-out-recovery';
import { createSession, loadOpenSession, saveSession } from '~/lib/channel/intake/session';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { handleLinqInboundRequest } from '~/lib/channel/linq/inbound';
import { threadIfParent } from '~/lib/channel/thread';
import type { SaidLineWriter } from '~/lib/channel/voice/said-line';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { failurePageCrisisPager } from '~/lib/monitoring/failure-page';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  defaultPartyReminderDeps,
  notifyGuestsOfCancellation,
  runPartyReminderCron,
} from './reminders';
import { submitRsvp } from './store';

/**
 * VIL-742 · a party guest ends the reminder in plain words, through the real door on the
 * real DDL. The reader is a fake at its port (rule #8): what the model makes of a guest's
 * words is the opt-out-read eval's job. These tests pin what the door hands the reader,
 * and what a stop reading then does to the guest's row.
 */

const FLAG = 'RSVP_GUEST_PLAIN_STOP_ENABLED';
const KEY = Buffer.alloc(32, 7).toString('base64');
const LINQ_KEY = Buffer.alloc(32, 9);
const TYPED = '416-555-0142';
const GUEST = '+14165550142';
const NOW = new Date('2026-11-20T15:30:00.000Z');
const PARTY_AT = new Date('2026-11-21T19:00:00.000Z');
const CONFIRMATION = 'Got it, I will not text you again.';
const STOP: OptOutReading = { intent: 'stop', confirmation: CONFIRMATION, language: 'en' };
const NOT_A_STOP: OptOutReading = { intent: 'none', confirmation: '', language: 'en' };

let db: TestDb;
let host: { familyId: string; parentUserId: string };
let inviteId: string;
/** The reader's text cache lives for a minute and is keyed on the words, so each test has its own. */
let textSeq = 0;
const words = () => {
  textSeq += 1;
  return `no reminder please ${textSeq}`;
};

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv(FLAG, 'true');
  vi.stubEnv('OPT_OUT_UNREAD_HOLD_TURN_ENABLED', 'false');
  host = await seedFamily(db.database, 'Host');
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
      publicToken: `token-${textSeq}-${Date.now()}`,
    })
    .returning({ id: schema.partyInvites.id });
  inviteId = invite?.id as string;
  const rsvp = await submitRsvp(
    db.database,
    { inviteId, familyId: host.familyId, cancelled: false },
    { displayName: 'Guest', response: 'yes', headcount: 1, reminderPhone: TYPED },
    NOW,
  );
  expect(rsvp).toMatchObject({ status: 'recorded', reminderOptIn: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec(
    'truncate table opt_out_held_messages, opt_out_read_holds, sms_intake_turn_claims, party_rsvps, party_invites, family_events, channel_messages, parent_channels, consent_records, audit_log, sms_intake_sessions, caregiver_invites, linq_group_roster_members, linq_group_rosters, linq_group_members, linq_multi_family_members, linq_shared_group_people, rate_limits, family_members, families, users cascade',
  );
});

function door(reading: OptOutReading | null, limiter?: RateLimiter) {
  const transport = new FakeTransport();
  const inputs: OptOutReadInput[] = [];
  const intake: IntakeDeps = {
    transport,
    threadMessage: async () => 'conv-1',
    openQuestions: fakeNoOpenQuestions,
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([]),
    radar: fakeRadar,
    answerComposer: fakeSilentAnswerComposer,
    identityAsk: new FakeIdentityAsk(),
    limiter: limiter ?? new FakeRateLimiter(() => NOW.getTime()),
    optOutReader: {
      read: async (input) => {
        inputs.push(input);
        return reading;
      },
    },
    now: NOW,
  };
  const deps: InboundRouteDeps = {
    database: db.database,
    intake: () => intake,
    enqueue: async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    countOutcome: async () => {},
    now: () => NOW,
  };
  return { transport, inputs, deps };
}

async function reply(
  text: string,
  reading: OptOutReading | null,
  over: { providerId?: string; isGroup?: boolean; from?: string; limiter?: RateLimiter } = {},
) {
  const { transport, inputs, deps } = door(reading, over.limiter);
  const outcome = await routeInboundText(
    deps,
    transport.inbound(over.from ?? GUEST, text, {
      providerId: over.providerId ?? `pm-${text}`,
      receivedAt: NOW,
      transport: 'imessage',
      chatId: 'chat-guest',
      isGroup: over.isGroup ?? false,
    }),
  );
  return { outcome, sent: transport.bodies(), inputs };
}

/** The guest's text as Linq's webhook delivers it, signed, through the real door. */
async function webhook(text: string, chat: { id: string; is_group?: boolean }) {
  vi.stubEnv('LINQ_WEBHOOK_SECRET', `whsec_${LINQ_KEY.toString('base64')}`);
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  const ts = String(Math.floor(NOW.getTime() / 1000));
  const body = JSON.stringify({
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: 'message.received',
    event_id: 'evt_guest',
    created_at: NOW.toISOString(),
    data: {
      chat,
      id: `pm-webhook-${text}`,
      direction: 'inbound',
      sender_handle: { handle: GUEST, is_me: false },
      parts: [{ type: 'text', value: text }],
      sent_at: NOW.toISOString(),
      service: 'iMessage',
    },
  });
  const mac = createHmac('sha256', LINQ_KEY).update(`evt_guest.${ts}.${body}`).digest('base64');
  const { inputs, deps } = door(NOT_A_STOP);
  await handleLinqInboundRequest(
    new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'evt_guest',
        'webhook-timestamp': ts,
        'webhook-signature': `v1,${mac}`,
      },
      body,
    }),
    { ...deps, markRead: async () => ({ status: 'accepted' as const }) },
  );
  return inputs;
}

async function optIn() {
  const [row] = await db.database
    .select({
      optIn: schema.partyRsvps.reminderOptInAt,
      hash: schema.partyRsvps.phoneE164Hash,
      enc: schema.partyRsvps.phoneE164Encrypted,
    })
    .from(schema.partyRsvps)
    .where(eq(schema.partyRsvps.partyInviteId, inviteId));
  return { optedIn: row?.optIn != null, hasNumber: row?.hash != null && row?.enc != null };
}

async function reminderCronSent() {
  const transport = new FakeTransport();
  const result = await runPartyReminderCron(
    db.database,
    { ...defaultPartyReminderDeps(), transport },
    NOW,
  );
  return { sent: result.sent, texted: transport.sent.length };
}

async function cancelNoticeSent() {
  const transport = new FakeTransport();
  const result = await notifyGuestsOfCancellation(
    db.database,
    { inviteId },
    { ...defaultPartyReminderDeps(), transport },
    NOW,
  );
  return { sent: result.sent, texted: transport.sent.length };
}

const phoneColumns = () => ({
  phoneE164Encrypted: encryptString(GUEST),
  phoneE164Hash: phoneBlindIndex(GUEST),
});

/** Every other way Hale can be in touch with a number. Each one means the reminder is not
 * the only thing Hale sends it, so the reader must not be told that it is. */
const OTHER_TIES: Record<string, () => Promise<void>> = {
  'a live channel': async () => {
    await db.database.insert(schema.parentChannels).values({
      userId: host.parentUserId,
      familyId: host.familyId,
      kind: 'sms',
      verifiedAt: NOW,
      ...phoneColumns(),
    });
  },
  'a revoked channel': async () => {
    await db.database.insert(schema.parentChannels).values({
      userId: host.parentUserId,
      familyId: host.familyId,
      kind: 'sms',
      verifiedAt: NOW,
      revokedAt: NOW,
      ...phoneColumns(),
    });
  },
  'an intake that became an account': async () => {
    const session = await createSession(db.database, {
      phoneE164: GUEST,
      state: 'awaiting_details',
      sourceCode: null,
    });
    await saveSession(
      db.database,
      session,
      { familyId: host.familyId, userId: host.parentUserId },
      NOW,
    );
  },
  'an open caregiver invite': async () => {
    await db.database.insert(schema.caregiverInvites).values({
      familyId: host.familyId,
      invitedByUserId: host.parentUserId,
      role: 'grandparent',
      displayName: 'grandma',
      state: 'awaiting_caregiver_reply',
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      ...phoneColumns(),
    });
  },
  'a household group seat': async () => {
    await db.database.insert(schema.linqGroupMembers).values({
      familyId: host.familyId,
      chatId: 'chat-family',
      userId: host.parentUserId,
      role: 'parent',
      ...phoneColumns(),
    });
  },
  'a group roster seat': async () => {
    const [roster] = await db.database
      .insert(schema.linqGroupRosters)
      .values({ chatId: 'chat-roster', source: 'new_group', status: 'roster_pending' })
      .returning({ id: schema.linqGroupRosters.id });
    await db.database.insert(schema.linqGroupRosterMembers).values({
      rosterId: roster?.id as string,
      chatId: 'chat-roster',
      status: 'proposed',
      ...phoneColumns(),
    });
  },
  'a multi-family group seat': async () => {
    await db.database.insert(schema.linqMultiFamilyMembers).values({
      chatId: 'chat-shared',
      familyId: host.familyId,
      userId: host.parentUserId,
      role: 'parent',
      ...phoneColumns(),
    });
  },
  'a shared group seat': async () => {
    await db.database.insert(schema.linqSharedGroupPeople).values({
      chatId: 'chat-shared',
      ...phoneColumns(),
    });
  },
};

describe('VIL-742 with the flag on: a guest ends the reminder in plain words', () => {
  it('a guest read as a stop is erased, gets the one confirmation, and hears nothing more', async () => {
    const text = words();
    const { outcome, sent, inputs } = await reply(text, STOP);

    expect(inputs).toEqual([{ text, language: null, region: null, partyGuest: true }]);
    expect(outcome).toBe('intake');
    expect(sent).toEqual([CONFIRMATION]);
    expect(await optIn()).toEqual({ optedIn: false, hasNumber: false });
    expect(await reminderCronSent()).toEqual({ sent: 0, texted: 0 });
    expect(await cancelNoticeSent()).toEqual({ sent: 0, texted: 0 });
  });

  it('positive control: a guest read as not a stop keeps the opt-in, and the reminder still goes', async () => {
    const { inputs } = await reply(words(), NOT_A_STOP);

    expect(inputs[0]?.partyGuest).toBe(true);
    expect(await optIn()).toEqual({ optedIn: true, hasNumber: true });
    expect(await reminderCronSent()).toEqual({ sent: 1, texted: 1 });
  });

  it('a redelivered guest stop, read without the fact it erased, greets nobody and sends nothing', async () => {
    const text = words();
    const first = await reply(text, STOP, { providerId: 'pm-redelivered' });
    expect(first.sent).toEqual([CONFIRMATION]);

    // The stop erased the opt-in, so the resend reads as an ordinary stranger's text.
    const again = await reply(text, NOT_A_STOP, { providerId: 'pm-redelivered' });

    expect(again.inputs[0]).not.toHaveProperty('partyGuest');
    expect(again.sent).toEqual([]);
    expect(await loadOpenSession(db.database, GUEST)).toBeNull();
    const claims = await db.database
      .select({ completedAt: schema.smsIntakeTurnClaims.completedAt })
      .from(schema.smsIntakeTurnClaims)
      .where(eq(schema.smsIntakeTurnClaims.providerMessageId, 'pm-redelivered'));
    expect(claims).toEqual([{ completedAt: NOW }]);
  });

  it('a different text from the same number after the stop is a new turn', async () => {
    await reply(words(), STOP, { providerId: 'pm-stopped' });

    await reply(words(), NOT_A_STOP, { providerId: 'pm-later' });

    expect(await loadOpenSession(db.database, GUEST)).not.toBeNull();
  });

  it('a guest over the rate limit is still read with the fact, and the stop lands', async () => {
    const overLimit: RateLimiter = {
      check: async () => ({ allowed: false, retryAfterSec: 60, firstDenied: false }),
    };
    const text = words();
    const { inputs, sent } = await reply(text, STOP, { limiter: overLimit });

    expect(inputs).toEqual([{ text, language: null, partyGuest: true }]);
    expect(sent).toEqual([CONFIRMATION]);
    expect(await optIn()).toEqual({ optedIn: false, hasNumber: false });
  });

  it('a guest text held through a model outage is re-read with the fact, and the stop lands silently', async () => {
    const text = words();
    const held = await reply(text, null, { providerId: 'pm-held' });
    expect(held.inputs[0]?.partyGuest).toBe(true);
    expect(await optIn()).toEqual({ optedIn: true, hasNumber: true });

    const transport = new FakeTransport();
    const inputs: OptOutReadInput[] = [];
    const later = new Date(NOW.getTime() + 3_600_000);
    const result = await recoverHeldOptOutReads(db.database, {
      reader: {
        read: async (input) => {
          inputs.push(input);
          return STOP;
        },
      },
      transport,
      preflight: async () => ({ proceed: true, health: null }),
      now: later,
      saidLine: {
        write: async () => {
          throw new Error('not a crisis');
        },
      } as SaidLineWriter,
      threadMessage: threadIfParent,
      crisisPager: failurePageCrisisPager(db.database, { now: later, post: async () => 'sent' }),
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ text, partyGuest: true });
    expect(inputs[0]?.late?.readAt).toEqual(later);
    expect(result.outcomes.read_not_stop).toBe(0);
    expect(await optIn()).toEqual({ optedIn: false, hasNumber: false });
    expect(transport.sent).toEqual([]);
  });
});

describe('VIL-742 who the reader is told is a guest', () => {
  it('with the flag off, a guest read carries no fact and the request is unchanged', async () => {
    vi.stubEnv(FLAG, 'false');
    const text = words();
    const { inputs } = await reply(text, NOT_A_STOP);

    expect(inputs).toEqual([{ text, language: null, region: null }]);
  });

  it.each(['True', 'true\n', '1'])('flag value %j is not on', async (value) => {
    vi.stubEnv(FLAG, value);
    const { inputs } = await reply(words(), NOT_A_STOP);

    expect(inputs[0]).not.toHaveProperty('partyGuest');
  });

  it('with the flag off, a held guest text is re-read with no fact', async () => {
    vi.stubEnv(FLAG, 'false');
    const text = words();
    await reply(text, null, { providerId: 'pm-held-off' });

    const inputs: OptOutReadInput[] = [];
    const later = new Date(NOW.getTime() + 3_600_000);
    await recoverHeldOptOutReads(db.database, {
      reader: {
        read: async (input) => {
          inputs.push(input);
          return NOT_A_STOP;
        },
      },
      transport: new FakeTransport(),
      preflight: async () => ({ proceed: true, health: null }),
      now: later,
      saidLine: {
        write: async () => {
          throw new Error('not a crisis');
        },
      } as SaidLineWriter,
      threadMessage: threadIfParent,
      crisisPager: failurePageCrisisPager(db.database, { now: later, post: async () => 'sent' }),
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).not.toHaveProperty('partyGuest');
  });

  it('a number with no opt-in is not a guest', async () => {
    const { inputs } = await reply(words(), NOT_A_STOP, { from: '+14165550143' });

    expect(inputs[0]).not.toHaveProperty('partyGuest');
  });

  it('a guest who already withdrew is not a guest', async () => {
    await db.database
      .update(schema.partyRsvps)
      .set({ reminderOptInAt: null, phoneE164Encrypted: null, phoneE164Hash: null })
      .where(eq(schema.partyRsvps.partyInviteId, inviteId));
    const { inputs } = await reply(words(), NOT_A_STOP);

    expect(inputs[0]).not.toHaveProperty('partyGuest');
  });

  it('a real Linq 1:1 webhook from a guest reaches the reader with the fact', async () => {
    const inputs = await webhook(words(), { id: 'chat-guest', is_group: false });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.partyGuest).toBe(true);
  });

  it('a Linq webhook that does not say it is 1:1 may be a group, so it carries no fact', async () => {
    const inputs = await webhook(words(), { id: 'chat-guest' });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).not.toHaveProperty('partyGuest');
  });

  it('a group turn never carries the fact, even from a guest', async () => {
    const { inputs } = await reply(words(), NOT_A_STOP, { isGroup: true });

    expect(inputs[0]).not.toHaveProperty('partyGuest');
  });

  it.each(Object.keys(OTHER_TIES))(
    'a guest who also has %s is not told it is the only thing',
    async (tie) => {
      await OTHER_TIES[tie]?.();
      const { inputs } = await reply(words(), NOT_A_STOP);

      expect(inputs).toHaveLength(1);
      expect(inputs[0]).not.toHaveProperty('partyGuest');
    },
  );
});
