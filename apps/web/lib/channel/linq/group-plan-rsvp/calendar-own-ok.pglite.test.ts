import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { loadIcsFeed, mintIcsToken } from '~/lib/loop/ics-feed';
import { failurePageOpsPager } from '~/lib/monitoring/failure-page';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { considerGroupExperience } from '../group-experience/inbound';
import { createPostgresGroupExperienceStore } from '../group-experience/store';
import { fakeGroupExperienceComposer } from '../group-experience/voice-fake';
import type { CalendarConsentReadInput } from './calendar';
import {
  considerCalendarTapback,
  considerGroupPlanRsvp,
  considerPrivateCalendarReply,
} from './inbound';
import { createPostgresGroupPlanRsvpStore } from './store';
import type { GroupLineInput } from './voice';
import { fakeGroupPlanRsvpComposer } from './voice-fake';

/**
 * A group plan reaches a family's calendar only through that parent's own 1:1 OK.
 * Every door is the real one on pglite; only Linq (the 1:1 send and the direct-chat
 * lookup), the readers and the composers are scripted.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-own-ok';
const A_PHONE = '+14375550181';
const B_PHONE = '+14375550182';
const S_PHONE = '+14375550183';
const C_PHONE = '+14375550184';
const NOW = new Date('2026-11-14T15:00:00.000Z');
const OLD_START = new Date('2026-11-14T16:00:00.000Z');
const NEW_START = new Date('2026-11-30T17:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('VERCEL_ENV', 'preview');
  vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_PLAN_RSVP_CALENDAR_ENABLED', 'true');
  vi.stubEnv('GROUP_POLLS_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users, rate_limits cascade');
});

async function family(name: string, chat?: string): Promise<string> {
  const [row] = await db.database
    .insert(schema.families)
    .values({
      displayName: name,
      provinceOrState: 'ON',
      primaryLanguage: 'en',
      ...(chat ? { linqGroupChatId: chat } : {}),
    })
    .returning({ id: schema.families.id });
  return row?.id as string;
}

type Role = 'primary_parent' | 'co_parent' | 'nanny';

/** A verified number: what a group seat or a web login code leaves behind. */
async function person(familyId: string, name: string, phone: string, role: Role) {
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${phone}`, name, timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({ familyId, userId, role });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  });
  return userId;
}

/** They texted Hale in their own 1:1 once: a thread exists. */
async function thread(familyId: string, userId: string, phone: string) {
  await db.database.insert(schema.channelMessages).values({
    familyId,
    parentUserId: userId,
    channel: 'imessage',
    direction: 'in',
    category: 'reply',
    status: 'delivered',
    providerChatId: dm(phone),
    inGroup: false,
    sentAt: at(-600),
    createdAt: at(-600),
  });
}

const dm = (phone: string) => `dm-${phone.slice(-4)}`;

async function joinShared(familyId: string, userId: string, phone: string) {
  const [consent] = await db.database
    .insert(schema.consentRecords)
    .values({
      userId,
      familyId,
      consentType: 'multi_family_group',
      granted: true,
      consentScope: CHAT,
      policyVersion: 'test',
    })
    .returning({ id: schema.consentRecords.id });
  await db.database.insert(schema.linqMultiFamilyJoins).values({
    chatId: CHAT,
    familyId,
    joinedByUserId: userId,
    consentRecordId: consent?.id,
    joinedAt: NOW,
  });
  await db.database.insert(schema.linqMultiFamilyMembers).values({
    chatId: CHAT,
    familyId,
    userId,
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    role: 'parent',
    seatedAt: NOW,
  });
}

/** Linq, scripted: each 1:1 text gets an id in that number's direct chat. */
function linq() {
  const lines: { to: string; body: string; id: string }[] = [];
  return {
    lines,
    oneToOne: {
      text: async (input: { to: string; body: string }) => {
        const id = `priv-${lines.length + 1}`;
        lines.push({ to: input.to, body: input.body, id });
        return { providerMessageId: id, chatId: dm(input.to) };
      },
      link: async () => ({ providerMessageId: 'link' }),
    },
    findDirectChat: async (phone: string) => dm(phone),
    to: (phone: string) => lines.filter((line) => line.to === phone),
  };
}

const yesReader = {
  read: async () => ({
    intent: 'rsvp' as const,
    planTitle: null,
    startsAt: null,
    location: null,
    deadline: null,
    response: 'yes' as const,
    headcount: 1,
    householdLabel: null,
    coversNames: [],
    confidence: 'high' as const,
  }),
};

const chatterReader = {
  read: async () => ({
    intent: 'chatter' as const,
    planTitle: null,
    startsAt: null,
    location: null,
    deadline: null,
    response: null,
    headcount: 1,
    householdLabel: null,
    coversNames: [],
    confidence: 'high' as const,
  }),
};

function okReader() {
  const seen: CalendarConsentReadInput[] = [];
  return {
    seen,
    read: async (input: CalendarConsentReadInput) => {
      seen.push(input);
      return { decision: 'ok' as const, confidence: 'high' as const };
    },
  };
}

async function events() {
  return db.database
    .select({
      familyId: schema.familyEvents.familyId,
      startsAt: schema.familyEvents.startsAt,
      deletedAt: schema.familyEvents.deletedAt,
    })
    .from(schema.familyEvents);
}

async function consentRows() {
  return db.database
    .select({
      familyId: schema.linqGroupPlanCalendarConsents.familyId,
      status: schema.linqGroupPlanCalendarConsents.status,
      ask: schema.linqGroupPlanCalendarConsents.askProviderMessageId,
    })
    .from(schema.linqGroupPlanCalendarConsents);
}

function rsvpPorts(out: ReturnType<typeof linq>, now: Date, extra: Record<string, unknown> = {}) {
  return {
    database: db.database,
    now,
    send: async () => ({ providerMessageId: `g-${now.getTime()}` }),
    reader: yesReader,
    composer: fakeGroupPlanRsvpComposer(),
    consentReader: okReader(),
    oneToOne: out.oneToOne,
    findDirectChat: out.findDirectChat,
    ...extra,
  };
}

async function plan(hostFamilyId: string, createdBy: string) {
  const plans = createPostgresGroupPlanRsvpStore(db.database);
  return plans.createPlan({
    chatId: CHAT,
    familyId: hostFamilyId,
    title: 'Saturday picnic',
    startsAt: OLD_START,
    location: 'the park',
    rsvpDeadlineAt: null,
    createdByUserId: createdBy,
    expected: [],
    now: NOW,
  });
}

async function timePoll(planId: string, hostFamilyId: string) {
  await createPostgresGroupExperienceStore(db.database).upsertLive({
    chatId: CHAT,
    familyId: hostFamilyId,
    kind: 'time_poll',
    subjectKey: planId,
    payload: {
      planId,
      options: [{ key: 'a', text: NEW_START.toISOString() }],
      votes: { [A_PHONE]: 'a', [S_PHONE]: 'a' },
    },
    now: NOW,
  });
}

function lockPorts(
  out: ReturnType<typeof linq>,
  now: Date,
  options: {
    groupLines?: string[];
    calendarComposer?: ReturnType<typeof fakeGroupPlanRsvpComposer>;
    posted?: string[];
  } = {},
) {
  const posted = options.posted ?? [];
  return {
    database: db.database,
    now,
    send: async ({ text }: { chatId: string; text: string }) => {
      options.groupLines?.push(text);
      return { providerMessageId: `lock-${now.getTime()}` };
    },
    reader: {
      read: async () => ({
        kind: 'time_lock' as const,
        title: null,
        response: null,
        optionKey: null,
        options: [],
        confidence: 'high' as const,
      }),
    },
    composer: fakeGroupExperienceComposer(),
    calendar: {
      composer: options.calendarComposer ?? fakeGroupPlanRsvpComposer(),
      oneToOne: out.oneToOne,
      findDirectChat: out.findDirectChat,
      pager: failurePageOpsPager(() => db.database, {
        now,
        post: async (text: string) => {
          posted.push(text);
          return 'sent' as const;
        },
      }),
    },
  };
}

async function lock(
  out: ReturnType<typeof linq>,
  hostFamilyId: string,
  sender: { phone: string; userId: string },
  now: Date,
  options: Parameters<typeof lockPorts>[2] = {},
) {
  return considerGroupExperience(lockPorts(out, now, options), {
    chatId: CHAT,
    senderHandle: sender.phone,
    senderUserId: sender.userId,
    senderFamilyId: hostFamilyId,
    coveringFamilyId: hostFamilyId,
    text: 'lock it',
  });
}

/** One household group, a co-parent, and a second family joined to the chat. */
async function world() {
  const famA = await family('A', CHAT);
  const a = await person(famA, 'Asha', A_PHONE, 'primary_parent');
  const b = await person(famA, 'Bo', B_PHONE, 'co_parent');
  const famS = await family('S');
  const s = await person(famS, 'Sol', S_PHONE, 'primary_parent');
  await joinShared(famS, s, S_PHONE);
  const created = await plan(famA, a);
  return { famA, a, b, famS, s, plan: created };
}

describe('a message in the group never answers the calendar ask', () => {
  for (const who of ['the parent who was asked', 'a co-parent who never got the ask'] as const) {
    it(`${who} typing an OK in the group writes nothing`, async () => {
      const w = await world();
      await thread(w.famA, w.a, A_PHONE);
      const out = linq();
      const yes = await considerGroupPlanRsvp(rsvpPorts(out, NOW), {
        chatId: CHAT,
        senderHandle: A_PHONE,
        senderUserId: w.a,
        text: 'we are in',
        tapback: null,
      });
      // Positive control: the yes did open the ask, in Asha's own 1:1.
      expect(yes).toMatchObject({ handled: true, calendar: { status: 'asked' } });
      expect(out.lines.map((line) => line.to)).toEqual([A_PHONE]);

      const consent = okReader();
      const sender =
        who === 'the parent who was asked' ? { p: A_PHONE, u: w.a } : { p: B_PHONE, u: w.b };
      await considerGroupPlanRsvp(
        rsvpPorts(out, at(1), { reader: chatterReader, consentReader: consent }),
        {
          chatId: CHAT,
          senderHandle: sender.p,
          senderUserId: sender.u,
          text: 'Yes, put the picnic on our calendar',
          tapback: null,
        },
      );
      expect(consent.seen).toEqual([]);
      expect(await events()).toEqual([]);
      expect(await consentRows()).toEqual([{ familyId: w.famA, status: 'asked', ask: 'priv-1' }]);
      expect(out.lines).toHaveLength(1);
    });
  }
});

describe("a parent's own 1:1 OK", () => {
  it('writes exactly one family_events row and its ICS entry for that household only', async () => {
    const w = await world();
    await thread(w.famA, w.a, A_PHONE);
    const out = linq();
    await considerGroupPlanRsvp(rsvpPorts(out, NOW), {
      chatId: CHAT,
      senderHandle: A_PHONE,
      senderUserId: w.a,
      text: 'we are in',
      tapback: null,
    });
    const reply = await considerPrivateCalendarReply(rsvpPorts(out, at(2)), {
      senderUserId: w.a,
      senderName: 'Asha',
      chatId: dm(A_PHONE),
      text: 'yes please add it',
    });
    expect(reply).toMatchObject({ handled: true, outcome: 'group_plan_calendar_written' });
    expect(await events()).toEqual([{ familyId: w.famA, startsAt: OLD_START, deletedAt: null }]);
    const feedA = await mintIcsToken(db.database, w.famA, 'feed_subscription');
    const feedS = await mintIcsToken(db.database, w.famS, 'feed_subscription');
    const icsA = await loadIcsFeed(db.database, feedA.token, NOW);
    const icsS = await loadIcsFeed(db.database, feedS.token, NOW);
    expect(icsA?.match(/SUMMARY:Saturday picnic/g)).toHaveLength(1);
    expect(icsS).not.toContain('Saturday picnic');
    expect(icsS).toContain('BEGIN:VCALENDAR');
    expect(out.to(A_PHONE).map((line) => line.body.split(' ')[0])).toEqual([
      'calendar_ask',
      'calendar_written',
    ]);
  });

  it('binds only to the ask that is Hale’s last 1:1 line, never to an older open ask', async () => {
    const w = await world();
    await thread(w.famA, w.a, A_PHONE);
    const out = linq();
    await considerGroupPlanRsvp(rsvpPorts(out, NOW), {
      chatId: CHAT,
      senderHandle: A_PHONE,
      senderUserId: w.a,
      text: 'we are in',
      tapback: null,
    });
    // A second plan in a shared chat no family claimed, where Asha holds a seat.
    const second = await createPostgresGroupPlanRsvpStore(db.database).createPlan({
      chatId: 'chat-own-ok-2',
      familyId: w.famA,
      title: 'Sunday skate',
      startsAt: NEW_START,
      location: 'the rink',
      rsvpDeadlineAt: null,
      createdByUserId: w.a,
      expected: [],
      now: NOW,
    });
    await db.database.insert(schema.linqGroupMembers).values({
      familyId: w.famA,
      chatId: 'chat-own-ok-2',
      userId: w.a,
      phoneE164Encrypted: encryptString(A_PHONE),
      phoneE164Hash: phoneBlindIndex(A_PHONE),
      role: 'parent',
      seatedAt: NOW,
    });
    // The second ask, for the same household, is the newest line in Asha's 1:1.
    await createPostgresGroupPlanRsvpStore(db.database).claimCalendarAsk({
      planId: second.id,
      familyId: w.famA,
      memberKey: 'asha',
      displayName: 'Asha',
      householdLabel: null,
      now: at(1),
    });
    await db.database.insert(schema.channelMessages).values({
      familyId: w.famA,
      parentUserId: w.a,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      providerMessageId: 'priv-newest',
      providerChatId: dm(A_PHONE),
      status: 'sent',
      sentAt: at(1),
      // The ledger orders a thread by insert time; the first ask was written just now.
      createdAt: new Date(Date.now() + 60_000),
    });
    await createPostgresGroupPlanRsvpStore(db.database).setCalendarAskMessage(
      second.id,
      w.famA,
      'priv-newest',
    );

    const consent = okReader();
    await considerPrivateCalendarReply(rsvpPorts(out, at(2), { consentReader: consent }), {
      senderUserId: w.a,
      senderName: 'Asha',
      chatId: dm(A_PHONE),
      text: 'yes',
    });
    expect(consent.seen.map((input) => input.ask.title)).toEqual(['Sunday skate']);
    const rows = await db.database
      .select({
        planId: schema.linqGroupPlanCalendarConsents.planId,
        status: schema.linqGroupPlanCalendarConsents.status,
      })
      .from(schema.linqGroupPlanCalendarConsents);
    expect(rows).toEqual(
      expect.arrayContaining([
        { planId: w.plan.id, status: 'asked' },
        { planId: second.id, status: 'written' },
      ]),
    );
    expect(await events()).toEqual([{ familyId: w.famA, startsAt: NEW_START, deletedAt: null }]);
  });
});

describe('the ask goes only to a parent who already has a 1:1 thread with Hale', () => {
  it('a seated co-parent with no 1:1 thread is not texted first, and the outcome names why', async () => {
    const w = await world();
    const out = linq();
    const yes = await considerGroupPlanRsvp(rsvpPorts(out, NOW), {
      chatId: CHAT,
      senderHandle: B_PHONE,
      senderUserId: w.b,
      text: 'we are in',
      tapback: null,
    });
    expect(yes).toMatchObject({ calendar: { status: 'skipped', reason: 'no_thread' } });
    expect(out.lines).toEqual([]);
    expect(await consentRows()).toEqual([]);

    // Positive control: the same yes from a parent with a thread is asked.
    await thread(w.famA, w.a, A_PHONE);
    const asked = await considerGroupPlanRsvp(rsvpPorts(out, at(1)), {
      chatId: CHAT,
      senderHandle: A_PHONE,
      senderUserId: w.a,
      text: 'we are in',
      tapback: null,
    });
    expect(asked).toMatchObject({ calendar: { status: 'asked' } });
    expect(out.lines.map((line) => line.to)).toEqual([A_PHONE]);
  });

  it('a caregiver who says yes is never asked', async () => {
    const w = await world();
    const c = await person(w.famA, 'Cam', C_PHONE, 'nanny');
    await thread(w.famA, c, C_PHONE);
    const out = linq();
    await considerGroupPlanRsvp(rsvpPorts(out, NOW), {
      chatId: CHAT,
      senderHandle: C_PHONE,
      senderUserId: c,
      text: 'we are in',
      tapback: null,
    });
    expect(out.lines).toEqual([]);
    expect(await consentRows()).toEqual([]);
  });
});

describe('a locked new start', () => {
  it('withdraws an ask whose RSVP row has no user id: a tap on the old ask writes nothing, and the new ask can', async () => {
    const w = await world();
    await thread(w.famS, w.s, S_PHONE);
    const out = linq();
    await considerGroupPlanRsvp(rsvpPorts(out, NOW), {
      chatId: CHAT,
      senderHandle: S_PHONE,
      senderUserId: w.s,
      text: 'we are in',
      tapback: null,
    });
    const rsvps = await db.database
      .select({ userId: schema.linqGroupPlanRsvps.userId })
      .from(schema.linqGroupPlanRsvps);
    expect(rsvps).toEqual([{ userId: null }]);
    const oldAsk = out.to(S_PHONE)[0];
    expect(oldAsk?.body).toContain('Nov 14');
    await timePoll(w.plan.id, w.famA);

    await lock(out, w.famA, { phone: A_PHONE, userId: w.a }, at(3));
    const tapOld = await considerCalendarTapback(rsvpPorts(out, at(4)), {
      senderUserId: w.s,
      senderName: 'Sol',
      messageId: oldAsk?.id ?? 'none',
      tapback: 'like',
    });
    expect(tapOld.handled).toBe(false);
    expect(await events()).toEqual([]);

    const asks = out.to(S_PHONE).filter((line) => line.body.startsWith('calendar_ask'));
    expect(asks).toHaveLength(2);
    expect(asks[1]?.body).toContain('Nov 30');
    const tapNew = await considerCalendarTapback(rsvpPorts(out, at(5)), {
      senderUserId: w.s,
      senderName: 'Sol',
      messageId: asks[1]?.id ?? 'none',
      tapback: 'like',
    });
    expect(tapNew).toMatchObject({ handled: true, outcome: 'group_plan_calendar_written' });
    expect(await events()).toEqual([{ familyId: w.famS, startsAt: NEW_START, deletedAt: null }]);
  });

  it('moves a copy the household already accepted, audits it in that household, and tells that parent', async () => {
    const w = await world();
    await thread(w.famS, w.s, S_PHONE);
    const out = linq();
    await considerGroupPlanRsvp(rsvpPorts(out, NOW), {
      chatId: CHAT,
      senderHandle: S_PHONE,
      senderUserId: w.s,
      text: 'we are in',
      tapback: null,
    });
    await considerPrivateCalendarReply(rsvpPorts(out, at(1)), {
      senderUserId: w.s,
      senderName: 'Sol',
      chatId: dm(S_PHONE),
      text: 'yes put it on our calendar',
    });
    expect(await events()).toEqual([{ familyId: w.famS, startsAt: OLD_START, deletedAt: null }]);
    await timePoll(w.plan.id, w.famA);

    await lock(out, w.famA, { phone: A_PHONE, userId: w.a }, at(3));
    expect(await events()).toEqual([{ familyId: w.famS, startsAt: NEW_START, deletedAt: null }]);
    const moved = await db.database
      .select({ familyId: schema.auditLog.familyId, targetTable: schema.auditLog.targetTable })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_plan_calendar_moved'));
    expect(moved).toEqual([{ familyId: w.famS, targetTable: 'family_events' }]);
    const last = out.to(S_PHONE).at(-1);
    expect(last?.body.split(' ')[0]).toBe('calendar_moved');
    expect(last?.body).toContain('Nov 30');
    expect(out.to(A_PHONE)).toEqual([]);
  });

  it('an OK still being read when the lock lands writes nothing, and the new ask stays open', async () => {
    const w = await world();
    await thread(w.famS, w.s, S_PHONE);
    const out = linq();
    await considerGroupPlanRsvp(rsvpPorts(out, NOW), {
      chatId: CHAT,
      senderHandle: S_PHONE,
      senderUserId: w.s,
      text: 'we are in',
      tapback: null,
    });
    await timePoll(w.plan.id, w.famA);
    const slowOk = {
      read: async () => {
        await lock(out, w.famA, { phone: A_PHONE, userId: w.a }, at(2));
        return { decision: 'ok' as const, confidence: 'high' as const };
      },
    };
    await considerPrivateCalendarReply(rsvpPorts(out, at(1), { consentReader: slowOk }), {
      senderUserId: w.s,
      senderName: 'Sol',
      chatId: dm(S_PHONE),
      text: 'yes put it on our calendar',
    });
    expect(await events()).toEqual([]);
    const asks = out.to(S_PHONE).filter((line) => line.body.startsWith('calendar_ask'));
    expect(asks).toHaveLength(2);
    expect(await consentRows()).toEqual([{ familyId: w.famS, status: 'asked', ask: asks[1]?.id }]);

    const tapNew = await considerCalendarTapback(rsvpPorts(out, at(5)), {
      senderUserId: w.s,
      senderName: 'Sol',
      messageId: asks[1]?.id ?? 'none',
      tapback: 'love',
    });
    expect(tapNew).toMatchObject({ handled: true, outcome: 'group_plan_calendar_written' });
    expect(await events()).toEqual([{ familyId: w.famS, startsAt: NEW_START, deletedAt: null }]);
  });

  it('a webhook retry of the lock re-asks no one twice', async () => {
    const w = await world();
    await thread(w.famS, w.s, S_PHONE);
    const out = linq();
    await considerGroupPlanRsvp(rsvpPorts(out, NOW), {
      chatId: CHAT,
      senderHandle: S_PHONE,
      senderUserId: w.s,
      text: 'we are in',
      tapback: null,
    });
    await timePoll(w.plan.id, w.famA);
    const groupLines: string[] = [];
    await lock(out, w.famA, { phone: A_PHONE, userId: w.a }, at(3), { groupLines });
    await lock(out, w.famA, { phone: A_PHONE, userId: w.a }, at(3), { groupLines });
    expect(groupLines).toHaveLength(1);
    const asks = out.to(S_PHONE).filter((line) => line.body.startsWith('calendar_ask'));
    expect(asks.map((line) => line.body.includes('Nov 30'))).toEqual([false, true]);
  });

  it('a move that fails pages #ops and leaves the copy at its old start', async () => {
    const w = await world();
    await thread(w.famS, w.s, S_PHONE);
    const out = linq();
    await considerGroupPlanRsvp(rsvpPorts(out, NOW), {
      chatId: CHAT,
      senderHandle: S_PHONE,
      senderUserId: w.s,
      text: 'we are in',
      tapback: null,
    });
    await considerPrivateCalendarReply(rsvpPorts(out, at(1)), {
      senderUserId: w.s,
      senderName: 'Sol',
      chatId: dm(S_PHONE),
      text: 'yes put it on our calendar',
    });
    await timePoll(w.plan.id, w.famA);
    await db.exec(`
      create function refuse_copy_move() returns trigger language plpgsql as $$
      begin raise exception 'copy move refused'; end $$;
      create trigger refuse_copy_move before update on family_events
      for each row execute function refuse_copy_move();
    `);
    const posted: string[] = [];
    try {
      await lock(out, w.famA, { phone: A_PHONE, userId: w.a }, at(3), { posted });
    } finally {
      await db.exec(
        'drop trigger refuse_copy_move on family_events; drop function refuse_copy_move();',
      );
    }
    expect(await events()).toEqual([{ familyId: w.famS, startsAt: OLD_START, deletedAt: null }]);
    expect(posted).toEqual(['Hale: ops page. site group_plan_calendar_move. failure move_failed.']);
  });

  it('when the model cannot write the moved line, the copy still moves and #ops is paged', async () => {
    const w = await world();
    await thread(w.famS, w.s, S_PHONE);
    const out = linq();
    await considerGroupPlanRsvp(rsvpPorts(out, NOW), {
      chatId: CHAT,
      senderHandle: S_PHONE,
      senderUserId: w.s,
      text: 'we are in',
      tapback: null,
    });
    await considerPrivateCalendarReply(rsvpPorts(out, at(1)), {
      senderUserId: w.s,
      senderName: 'Sol',
      chatId: dm(S_PHONE),
      text: 'yes put it on our calendar',
    });
    await timePoll(w.plan.id, w.famA);
    const sentBefore = out.lines.length;
    const posted: string[] = [];
    const mute = fakeGroupPlanRsvpComposer({
      body: (input: GroupLineInput) => {
        if (input.kind === 'calendar_moved') throw new Error('fake voice: model failed');
        return `${input.kind}.`;
      },
    });
    await lock(out, w.famA, { phone: A_PHONE, userId: w.a }, at(3), {
      posted,
      calendarComposer: mute,
    });
    expect(await events()).toEqual([{ familyId: w.famS, startsAt: NEW_START, deletedAt: null }]);
    expect(out.lines).toHaveLength(sentBefore);
    expect(posted).toEqual([
      'Hale: ops page. site group_plan_calendar_move. failure line_unwritten.',
    ]);
    const audits = await db.database
      .select({ familyId: schema.auditLog.familyId })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actionTaken, 'linq_group_plan_calendar_moved'),
          eq(schema.auditLog.familyId, w.famS),
        ),
      );
    expect(audits).toHaveLength(1);
  });
});
