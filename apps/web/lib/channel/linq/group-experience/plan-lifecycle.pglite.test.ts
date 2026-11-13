import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { PrivateAsideModel } from '../group-private-aside';
import { postgresGroupPlanCalendarWriter } from '../group-plan-rsvp/calendar';
import { createPostgresGroupPlanRsvpStore } from '../group-plan-rsvp/store';
import { fakeGroupPlanRsvpComposer } from '../group-plan-rsvp/voice-fake';
import { handleLinqGroupMessage } from '../inbound';
import type { SharedGroupReader } from '../shared-group-reading';
import { fakeSharedGroupComposer } from '../shared-group-voice-fake';
import { considerGroupExperience } from './inbound';
import type { GroupExperienceReading } from './reading';
import { createPostgresGroupExperienceStore } from './store';
import { fakeGroupExperienceComposer } from './voice-fake';

/**
 * VIL-689 · a group plan has a lifecycle, and a time poll binds to the plan it is about.
 * Gate probes P1, P6 and P7 (11-12) are the regression cases: a zoo poll re-timed an older
 * picnic plan and asked its yes household about the wrong event, and a lock that moved a
 * plan left a household's written calendar copy at the old time.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-plan-life';
// 16:00Z is 11:00 in Toronto: daytime for every household here.
const NOW = new Date('2026-11-12T16:00:00.000Z');
// 03:00Z is 22:00 in Toronto: quiet hours.
const NIGHT = new Date('2026-11-13T03:00:00.000Z');
const PARENT_A = '+15555550111';
const PARENT_B = '+15555550122';
const FROM = '+15555550100';
const SATURDAY_10 = '2026-11-14T10:00:00-05:00';
const SUNDAY_14 = '2026-11-15T14:00:00-05:00';

let db: TestDb;
beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_FROM_E164', FROM);
  for (const flag of [
    'LINQ_MULTI_FAMILY_GROUPS_ENABLED',
    'LINQ_GROUP_MEMBERS_ENABLED',
    'GROUP_POLLS_ENABLED',
    'GROUP_LINK_CARDS_ENABLED',
    'GROUP_PRIVATE_QUESTION_ENABLED',
    'LINQ_GROUP_PLAN_RSVP_ENABLED',
    'LINQ_GROUP_PLAN_RSVP_CALENDAR_ENABLED',
    'LINQ_GROUP_POLLS_ENABLED',
  ]) {
    vi.stubEnv(flag, 'true');
  }
});
afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table families, users, linq_shared_group_people, linq_multi_family_joins, linq_multi_family_members, linq_group_experience, linq_group_plans, linq_group_polls, audit_log, channel_messages cascade',
  );
});

async function seedFamily(phone: string, name: string) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}`, name, timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId, role: 'primary_parent' });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  });
  await db.database.insert(schema.linqSharedGroupPeople).values({
    chatId: CHAT,
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    familyId,
    userId,
    firstName: name,
  });
  await db.database
    .insert(schema.linqMultiFamilyJoins)
    .values({ chatId: CHAT, familyId, joinedByUserId: userId, joinedAt: NOW });
  await db.database.insert(schema.linqMultiFamilyMembers).values({
    chatId: CHAT,
    familyId,
    userId,
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    role: 'parent',
  });
  return { familyId, userId };
}

function reading(partial: Partial<GroupExperienceReading>): GroupExperienceReading {
  return {
    kind: 'none',
    title: null,
    samePlan: null,
    response: null,
    optionKey: null,
    options: [],
    starts: [],
    confidence: 'high',
    ...partial,
  };
}

async function picnicWithAdaYes(startsAt: Date | null, memberKey?: string) {
  const a = await seedFamily(PARENT_A, 'Ada');
  const b = await seedFamily(PARENT_B, 'Bao');
  const plans = createPostgresGroupPlanRsvpStore(db.database);
  const picnic = await plans.createPlan({
    chatId: CHAT,
    familyId: a.familyId,
    title: 'picnic',
    startsAt,
    location: null,
    rsvpDeadlineAt: null,
    createdByUserId: a.userId,
    expected: [],
    now: NOW,
  });
  await plans.upsertRsvp({
    planId: picnic.id,
    memberKey: memberKey ?? `key-${a.userId}`,
    displayName: 'Ada',
    householdLabel: null,
    userId: a.userId,
    haleCustomer: true,
    response: 'yes',
    headcount: 1,
    source: 'text',
    coversKeys: [],
    verbatim: null,
    now: NOW,
  });
  return { a, b, picnic, plans };
}

/** Ada's household's copy of the picnic is written at Saturday 10 (the VIL-503 end state). */
async function writeAdaCopy(planId: string, familyId: string, userId: string) {
  const plans = createPostgresGroupPlanRsvpStore(db.database);
  const written = await postgresGroupPlanCalendarWriter(db.database).write({
    planId,
    chatId: CHAT,
    familyId,
    title: 'picnic',
    startsAt: new Date(SATURDAY_10),
    location: null,
  });
  if (written.status === 'failed') throw new Error('seed write failed');
  await plans.claimCalendarAsk({
    planId,
    familyId,
    memberKey: `key-${userId}`,
    displayName: 'Ada',
    householdLabel: null,
    now: NOW,
  });
  await plans.markCalendarWritten({
    planId,
    familyId,
    familyEventId: written.familyEventId,
    actorUserId: userId,
    now: NOW,
  });
}

function directPorts(read: GroupExperienceReading, now: Date = NOW) {
  const group: string[] = [];
  const texted: { to: string; body: string }[] = [];
  return {
    group,
    texted,
    ports: {
      database: db.database,
      now,
      send: async ({ text }: { chatId: string; text: string }) => {
        group.push(text);
        return { providerMessageId: `g-${group.length}` };
      },
      oneToOne: {
        text: async ({ to, body }: { to: string; body: string }) => {
          texted.push({ to, body });
          return { providerMessageId: `dm-${texted.length}`, chatId: `dm-${texted.length}` };
        },
        link: async () => ({ providerMessageId: 'unused' }),
      },
      calendarComposer: fakeGroupPlanRsvpComposer(),
      reader: { read: async () => read },
      composer: fakeGroupExperienceComposer(),
    },
  };
}

async function seedTimePoll(familyId: string, planId: string | null) {
  await createPostgresGroupExperienceStore(db.database).upsertLive({
    chatId: CHAT,
    familyId,
    kind: 'time_poll',
    subjectKey: planId ?? `time:${CHAT}`,
    payload: {
      planId,
      options: [
        { key: 'o1', text: 'Saturday 10', choiceValue: 'o1', startsAt: SATURDAY_10 },
        { key: 'o2', text: 'Sunday 2', choiceValue: 'o2', startsAt: SUNDAY_14 },
      ],
      votes: { [PARENT_A]: 'o2', [PARENT_B]: 'o2' },
    },
    now: NOW,
  });
}

async function planRow(id: string) {
  const [row] = await db.database
    .select()
    .from(schema.linqGroupPlans)
    .where(eq(schema.linqGroupPlans.id, id));
  return row;
}

describe('a time poll binds to the plan it is about (probe P6)', () => {
  it('a poll for another event opens its own plan, keeps the older one (still ahead) open, and never re-times it', async () => {
    const { a, picnic } = await picnicWithAdaYes(null);
    const open = directPorts(
      reading({
        kind: 'time_open',
        title: 'zoo',
        samePlan: false,
        options: ['Saturday 10', 'Sunday 2'],
        starts: [SATURDAY_10, SUNDAY_14],
      }),
    );
    await considerGroupExperience(open.ports, {
      chatId: CHAT,
      senderHandle: PARENT_A,
      senderUserId: a.userId,
      senderFamilyId: a.familyId,
      coveringFamilyId: a.familyId,
      text: 'Hale can you poll Saturday 10 or Sunday 2 for the zoo?',
      messageId: 'm-1',
      planRef: { status: 'other' },
    });
    const [poll] = await db.database
      .select()
      .from(schema.linqGroupExperience)
      .where(eq(schema.linqGroupExperience.kind, 'time_poll'));
    const pollPlanId = (poll?.payload as { planId: string | null }).planId;
    expect(pollPlanId).not.toBeNull();
    expect(pollPlanId).not.toBe(picnic.id);
    const zoo = await planRow(pollPlanId as string);
    expect(zoo?.title).toBe('zoo');
    expect((await planRow(picnic.id))?.closedAt).toBeNull();
    const closed = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actionTaken, 'linq_group_plan_closed'),
          eq(schema.auditLog.targetId, picnic.id),
        ),
      );
    expect(closed).toEqual([]);

    await createPostgresGroupExperienceStore(db.database).patchPayload(
      poll?.id as string,
      {
        ...(poll?.payload as Record<string, unknown>),
        votes: { [PARENT_A]: 'o2', [PARENT_B]: 'o2' },
      },
      NOW,
    );
    const lock = directPorts(reading({ kind: 'time_lock' }));
    await considerGroupExperience(lock.ports, {
      chatId: CHAT,
      senderHandle: PARENT_A,
      senderUserId: a.userId,
      senderFamilyId: a.familyId,
      coveringFamilyId: a.familyId,
      text: 'Sunday it is, lock it in Hale',
      messageId: 'm-2',
    });
    expect((await planRow(picnic.id))?.startsAt).toBeNull();
    expect((await planRow(pollPlanId as string))?.startsAt?.toISOString()).toBe(
      new Date(SUNDAY_14).toISOString(),
    );
    expect(lock.texted).toEqual([]);
    const asks = await db.database.select().from(schema.linqGroupPlanCalendarConsents);
    expect(asks).toEqual([]);
  });

  it('a poll the reader does not tie to the open plan, with no event named, binds to no plan', async () => {
    const { a, picnic } = await picnicWithAdaYes(null);
    const open = directPorts(
      reading({
        kind: 'time_open',
        samePlan: null,
        options: ['Saturday 10', 'Sunday 2'],
        starts: [SATURDAY_10, SUNDAY_14],
      }),
    );
    await considerGroupExperience(open.ports, {
      chatId: CHAT,
      senderHandle: PARENT_A,
      senderUserId: a.userId,
      senderFamilyId: a.familyId,
      coveringFamilyId: a.familyId,
      text: 'can we vote saturday 10 or sunday 2',
      messageId: 'm-3',
    });
    const [poll] = await db.database
      .select()
      .from(schema.linqGroupExperience)
      .where(eq(schema.linqGroupExperience.kind, 'time_poll'));
    expect((poll?.payload as { planId: string | null }).planId).toBeNull();
    expect((await planRow(picnic.id))?.closedAt).toBeNull();
  });

  it('a lock on a poll whose plan has since closed moves nothing', async () => {
    const { a, b, picnic } = await picnicWithAdaYes(null);
    await seedTimePoll(a.familyId, picnic.id);
    await db.database
      .update(schema.linqGroupPlans)
      .set({ closedAt: NOW })
      .where(eq(schema.linqGroupPlans.id, picnic.id));
    const lock = directPorts(reading({ kind: 'time_lock' }));
    await considerGroupExperience(lock.ports, {
      chatId: CHAT,
      senderHandle: PARENT_B,
      senderUserId: b.userId,
      senderFamilyId: b.familyId,
      coveringFamilyId: a.familyId,
      text: 'lock it in',
      messageId: 'm-4',
    });
    expect((await planRow(picnic.id))?.startsAt).toBeNull();
    expect(lock.texted).toEqual([]);
  });
});

describe('a plan whose start has passed closes', () => {
  it('is no longer the live plan, and its close is audited', async () => {
    const past = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
    const { picnic, plans } = await picnicWithAdaYes(past);
    expect(await plans.listOpenPlans(CHAT, NOW)).toEqual([]);
    expect((await planRow(picnic.id))?.closedAt).not.toBeNull();
    const closed = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_plan_closed'));
    expect(closed.map((row) => (row.after as { reason: string }).reason)).toEqual(['past']);
  });

  it('a plan still ahead stays live (positive control)', async () => {
    const { picnic, plans } = await picnicWithAdaYes(new Date(SATURDAY_10));
    expect((await plans.listOpenPlans(CHAT, NOW)).map((plan) => plan.id)).toEqual([picnic.id]);
  });
});

describe('a lock that moves a plan moves the copies households already have (probe P1)', () => {
  it('moves the written copy and sends that household one notice, by day', async () => {
    const { a, picnic } = await picnicWithAdaYes(new Date(SATURDAY_10));
    await writeAdaCopy(picnic.id, a.familyId, a.userId);
    await seedTimePoll(a.familyId, picnic.id);
    const lock = directPorts(reading({ kind: 'time_lock' }));
    await considerGroupExperience(lock.ports, {
      chatId: CHAT,
      senderHandle: PARENT_A,
      senderUserId: a.userId,
      senderFamilyId: a.familyId,
      coveringFamilyId: a.familyId,
      text: 'Sunday it is, lock it in Hale',
      messageId: 'm-5',
    });
    const copies = await db.database
      .select({ familyId: schema.familyEvents.familyId, startsAt: schema.familyEvents.startsAt })
      .from(schema.familyEvents);
    expect(copies).toEqual([{ familyId: a.familyId, startsAt: new Date(SUNDAY_14) }]);
    expect(lock.texted.map((line) => line.to)).toEqual([PARENT_A]);
    expect(lock.texted[0]?.body).toContain('calendar_moved');
    const moved = await db.database
      .select({ familyId: schema.auditLog.familyId })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_plan_calendar_moved'));
    expect(moved).toEqual([{ familyId: a.familyId }]);
  });

  it('at night the copy moves now and the notice waits for the morning', async () => {
    const { a, picnic } = await picnicWithAdaYes(new Date(SATURDAY_10));
    await writeAdaCopy(picnic.id, a.familyId, a.userId);
    await seedTimePoll(a.familyId, picnic.id);
    const lock = directPorts(reading({ kind: 'time_lock' }), NIGHT);
    await considerGroupExperience(lock.ports, {
      chatId: CHAT,
      senderHandle: PARENT_A,
      senderUserId: a.userId,
      senderFamilyId: a.familyId,
      coveringFamilyId: a.familyId,
      text: 'Sunday it is, lock it in Hale',
      messageId: 'm-6',
    });
    const copies = await db.database
      .select({ startsAt: schema.familyEvents.startsAt })
      .from(schema.familyEvents);
    expect(copies).toEqual([{ startsAt: new Date(SUNDAY_14) }]);
    expect(lock.texted).toEqual([]);
    const moved = await db.database
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_plan_calendar_moved'));
    expect(moved).toHaveLength(1);
  });
});

const sharedReader: SharedGroupReader = {
  async read() {
    return {
      intent: 'question',
      role: 'unclear',
      familyLabel: null,
      kidName: null,
      confidence: 'high',
    };
  },
};
const noAside: PrivateAsideModel = {
  async read() {
    return [];
  },
  async draft() {
    return { send: false, about: '', text: '' };
  },
};

describe('probe P7 through the real group door, every group flag on', () => {
  it('a zoo poll and lock never re-time the older picnic plan or ask its household about it', async () => {
    const { picnic } = await picnicWithAdaYes(null, phoneBlindIndex(PARENT_A));
    const dms: string[] = [];
    const run = async (text: string, from: string, id: string, exp: GroupExperienceReading) => {
      const response = await handleLinqGroupMessage(
        {
          database: db.database,
          log: { info: () => {}, warn: () => {}, error: () => {} },
          countOutcome: async () => {},
          enqueue: async () => {},
          now: () => NOW,
          sendGroupText: async () => ({ providerMessageId: `g-${id}` }),
          oneToOne: {
            text: async ({ body }: { to: string; body: string }) => {
              dms.push(body);
              return { providerMessageId: `dm-${dms.length}`, chatId: `dm-${dms.length}` };
            },
            link: async () => ({ providerMessageId: 'unused' }),
          },
          listChatHandles: async () => ({ status: 'ok', handles: [PARENT_A, PARENT_B] }),
          sharedGroupReader: sharedReader,
          sharedGroupVoice: fakeSharedGroupComposer({ body: 'shared-reply-line' }),
          privateAsideModel: noAside,
          groupPlanRsvpReader: {
            read: async () => ({
              intent: 'chatter',
              planTitle: null,
              startsAt: null,
              location: null,
              deadline: null,
              response: null,
              headcount: 1,
              householdLabel: null,
              coversNames: [],
              confidence: 'high',
              planKey: null,
              replacesPlanKey: null,
              addressed: false,
            }),
          },
          groupPlanRsvpComposer: fakeGroupPlanRsvpComposer(),
          groupExperienceReader: { read: async () => exp },
          groupExperienceComposer: fakeGroupExperienceComposer(),
        } as unknown as Parameters<typeof handleLinqGroupMessage>[0],
        {
          messageId: id,
          chatId: CHAT,
          senderHandle: from,
          text,
          mediaCount: 0,
          receivedAt: NOW,
          otherHandles: [from === PARENT_A ? PARENT_B : PARENT_A],
          mentions: [],
          isGroup: true,
        },
      );
      return (await response.json()) as Record<string, unknown>;
    };
    await run(
      'Hale can you poll Saturday 10 or Sunday 2 for the zoo?',
      PARENT_A,
      'm1',
      reading({
        kind: 'time_open',
        title: 'zoo',
        samePlan: false,
        options: ['Saturday 10', 'Sunday 2'],
        starts: [SATURDAY_10, SUNDAY_14],
      }),
    );
    await run('Sunday for us', PARENT_A, 'm2', reading({ kind: 'time_vote', optionKey: 'o2' }));
    await run('sunday works', PARENT_B, 'm3', reading({ kind: 'time_vote', optionKey: 'o2' }));
    await run('Sunday it is, lock it in Hale', PARENT_B, 'm4', reading({ kind: 'time_lock' }));
    expect((await planRow(picnic.id))?.startsAt).toBeNull();
    expect(dms.filter((body) => body.includes('picnic'))).toEqual([]);
  });
});

describe('scene 03 when VIL-471 owns the poll', () => {
  it('a lock names the single leader in the group and closes that poll', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    const b = await seedFamily(PARENT_B, 'Bao');
    const plans = createPostgresGroupPlanRsvpStore(db.database);
    const poll = await plans.createPoll({
      chatId: CHAT,
      familyId: a.familyId,
      question: 'zoo when?',
      options: [
        { text: 'Saturday 10', providerOptionId: null },
        { text: 'Sunday 2', providerOptionId: null },
      ],
      expected: [],
      origin: 'parent',
      providerMessageId: null,
      now: NOW,
    });
    for (const [key, name] of [
      ['key-a', 'Ada'],
      ['key-b', 'Bao'],
    ] as const) {
      await plans.recordPollVote({
        pollId: poll.id,
        memberKey: key,
        displayName: name,
        userId: null,
        haleCustomer: true,
        optionKey: 'o2',
        source: 'text',
        now: NOW,
      });
    }
    const lock = directPorts(reading({ kind: 'time_lock' }));
    const facts: Record<string, unknown>[] = [];
    lock.ports.composer = fakeGroupExperienceComposer({
      body: (input) => {
        facts.push(input.facts);
        return `${input.kind}.`;
      },
    });
    const out = await considerGroupExperience(lock.ports, {
      chatId: CHAT,
      senderHandle: PARENT_B,
      senderUserId: b.userId,
      senderFamilyId: b.familyId,
      coveringFamilyId: a.familyId,
      text: 'Sunday it is, lock it in Hale',
      messageId: 'm-7',
    });
    expect(out).toMatchObject({ handled: true, outcome: 'group_experience_spoken' });
    expect(lock.group).toEqual(['time_lock.']);
    expect(facts).toEqual([{ winner: 'Sunday 2' }]);
    expect(await plans.loadLivePoll(CHAT)).toBeNull();
  });

  it('a tie locks nothing, keeps the poll open, and asks which in one line (control)', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    const b = await seedFamily(PARENT_B, 'Bao');
    const plans = createPostgresGroupPlanRsvpStore(db.database);
    const poll = await plans.createPoll({
      chatId: CHAT,
      familyId: a.familyId,
      question: 'zoo when?',
      options: [
        { text: 'Saturday 10', providerOptionId: null },
        { text: 'Sunday 2', providerOptionId: null },
      ],
      expected: [],
      origin: 'parent',
      providerMessageId: null,
      now: NOW,
    });
    for (const [key, option] of [
      ['key-a', 'o1'],
      ['key-b', 'o2'],
    ] as const) {
      await plans.recordPollVote({
        pollId: poll.id,
        memberKey: key,
        displayName: key,
        userId: null,
        haleCustomer: true,
        optionKey: option,
        source: 'text',
        now: NOW,
      });
    }
    const lock = directPorts(reading({ kind: 'time_lock' }));
    await considerGroupExperience(lock.ports, {
      chatId: CHAT,
      senderHandle: PARENT_B,
      senderUserId: b.userId,
      senderFamilyId: b.familyId,
      coveringFamilyId: a.familyId,
      text: 'lock it in Hale',
      messageId: 'm-8',
    });
    expect(lock.group).toHaveLength(1);
    expect(lock.group[0]).toContain('time_tie');
    expect((await plans.loadLivePoll(CHAT))?.id).toBe(poll.id);
  });
});

describe('a VIL-471 lock on a poll about the open plan moves the plan and its copies (gate R3, probe V5)', () => {
  async function placedPoll(planId: string, familyId: string, picks: readonly string[]) {
    const plans = createPostgresGroupPlanRsvpStore(db.database);
    const poll = await plans.createPoll({
      chatId: CHAT,
      familyId,
      question: 'picnic when?',
      options: [
        { text: 'Saturday 10', providerOptionId: null, places: { planId, startsAt: SATURDAY_10 } },
        { text: 'Sunday 2', providerOptionId: null, places: { planId, startsAt: SUNDAY_14 } },
      ],
      expected: [],
      origin: 'parent',
      providerMessageId: null,
      now: NOW,
    });
    for (const [index, optionKey] of picks.entries()) {
      await plans.recordPollVote({
        pollId: poll.id,
        memberKey: `key-${index}`,
        displayName: `voter ${index}`,
        userId: null,
        haleCustomer: true,
        optionKey,
        source: 'text',
        now: NOW,
      });
    }
    return { plans, poll };
  }

  /** `by` sends the lock: the plan's host (Ada) unless a test says otherwise. */
  async function lockWith(
    a: { familyId: string },
    by: { familyId: string; userId: string; handle: string },
    lockChoice?: string,
  ) {
    const lock = directPorts(reading({ kind: 'none' }));
    const facts: Record<string, unknown>[] = [];
    lock.ports.composer = fakeGroupExperienceComposer({
      body: (input) => {
        facts.push(input.facts);
        return input.questions === 1 ? `${input.kind}?` : `${input.kind}.`;
      },
    });
    await considerGroupExperience(lock.ports, {
      chatId: CHAT,
      senderHandle: by.handle,
      senderUserId: by.userId,
      senderFamilyId: by.familyId,
      coveringFamilyId: a.familyId,
      text: 'Sunday it is, lock it in Hale',
      messageId: 'm-lock',
      decided: 'time_lock',
      ...(lockChoice ? { lockChoice } : {}),
    });
    return { ...lock, facts };
  }

  it('locking Sunday moves the plan to Sunday 2, moves the household copy, and tells that household once', async () => {
    const { a, picnic } = await picnicWithAdaYes(new Date(SATURDAY_10));
    await writeAdaCopy(picnic.id, a.familyId, a.userId);
    const { plans } = await placedPoll(picnic.id, a.familyId, ['o2', 'o2']);
    const lock = await lockWith(a, { ...a, handle: PARENT_A });
    expect(lock.facts).toEqual([{ winner: 'Sunday 2' }]);
    expect((await planRow(picnic.id))?.startsAt).toEqual(new Date(SUNDAY_14));
    const copies = await db.database
      .select({ familyId: schema.familyEvents.familyId, startsAt: schema.familyEvents.startsAt })
      .from(schema.familyEvents);
    expect(copies).toEqual([{ familyId: a.familyId, startsAt: new Date(SUNDAY_14) }]);
    expect(lock.texted.map((line) => line.to)).toEqual([PARENT_A]);
    expect(lock.texted[0]?.body).toContain('calendar_moved');
    expect(await plans.loadLivePoll(CHAT)).toBeNull();
  });

  it('a named choice never beats the leader: Saturday named while Sunday leads locks Sunday', async () => {
    const { a, picnic } = await picnicWithAdaYes(new Date(SATURDAY_10));
    await placedPoll(picnic.id, a.familyId, ['o2', 'o2']);
    const lock = await lockWith(a, { ...a, handle: PARENT_A }, 'o1');
    expect(lock.facts).toEqual([{ winner: 'Sunday 2' }]);
    expect((await planRow(picnic.id))?.startsAt).toEqual(new Date(SUNDAY_14));
  });

  it('a named choice breaks a tie among the leaders when the host locks', async () => {
    const { a, picnic } = await picnicWithAdaYes(new Date(SUNDAY_14));
    await placedPoll(picnic.id, a.familyId, ['o1', 'o2']);
    const lock = await lockWith(a, { ...a, handle: PARENT_A }, 'o1');
    expect(lock.facts).toEqual([{ winner: 'Saturday 10' }]);
    expect((await planRow(picnic.id))?.startsAt).toEqual(new Date(SATURDAY_10));
  });

  it('a lock from another household that would move the plan closes nothing and moves nothing', async () => {
    const { a, b, picnic } = await picnicWithAdaYes(new Date(SATURDAY_10));
    await writeAdaCopy(picnic.id, a.familyId, a.userId);
    const { plans } = await placedPoll(picnic.id, a.familyId, ['o2', 'o2']);
    const lock = await lockWith(a, { ...b, handle: PARENT_B }, 'o2');
    expect(lock.group).toEqual([]);
    expect((await planRow(picnic.id))?.startsAt).toEqual(new Date(SATURDAY_10));
    expect(await plans.loadLivePoll(CHAT)).not.toBeNull();
    expect(lock.texted).toEqual([]);
  });

  it('positive control: the poll creator may lock it even from another household', async () => {
    const { a, b, picnic } = await picnicWithAdaYes(new Date(SATURDAY_10));
    const plans = createPostgresGroupPlanRsvpStore(db.database);
    await plans.createPoll({
      chatId: CHAT,
      familyId: b.familyId,
      question: 'picnic when?',
      options: [
        {
          text: 'Saturday 10',
          providerOptionId: null,
          places: { planId: picnic.id, startsAt: SATURDAY_10 },
        },
        {
          text: 'Sunday 2',
          providerOptionId: null,
          places: { planId: picnic.id, startsAt: SUNDAY_14 },
        },
      ],
      expected: [],
      origin: 'parent',
      providerMessageId: null,
      createdByMemberKey: phoneBlindIndex(PARENT_B),
      now: NOW,
    });
    const lock = await lockWith(a, { ...b, handle: PARENT_B }, 'o2');
    expect(lock.facts).toEqual([{ winner: 'Sunday 2' }]);
    expect((await planRow(picnic.id))?.startsAt).toEqual(new Date(SUNDAY_14));
  });

  it('a tie with only an unauthorized pick asks which, in one line, and moves nothing', async () => {
    const { a, b, picnic } = await picnicWithAdaYes(new Date(SATURDAY_10));
    await placedPoll(picnic.id, a.familyId, ['o1', 'o2']);
    const lock = await lockWith(a, { ...b, handle: PARENT_B }, 'o2');
    expect(lock.facts).toEqual([{ leaders: ['Saturday 10', 'Sunday 2'] }]);
    expect(lock.group).toEqual(['time_tie?']);
    expect((await planRow(picnic.id))?.startsAt).toEqual(new Date(SATURDAY_10));
  });

  it('a poll placed on a plan that has since closed moves nothing', async () => {
    const { a, b, picnic } = await picnicWithAdaYes(new Date(SATURDAY_10));
    await writeAdaCopy(picnic.id, a.familyId, a.userId);
    await placedPoll(picnic.id, a.familyId, ['o2', 'o2']);
    await db.database
      .update(schema.linqGroupPlans)
      .set({ closedAt: NOW })
      .where(eq(schema.linqGroupPlans.id, picnic.id));
    const lock = await lockWith(a, { ...b, handle: PARENT_B });
    expect((await planRow(picnic.id))?.startsAt).toEqual(new Date(SATURDAY_10));
    expect(lock.texted).toEqual([]);
  });
});

describe('the OK asks a lock sends to yes households go out by day only', () => {
  async function lockAt(now: Date) {
    const { a, picnic } = await picnicWithAdaYes(null);
    await seedTimePoll(a.familyId, picnic.id);
    const lock = directPorts(reading({ kind: 'time_lock' }), now);
    await considerGroupExperience(lock.ports, {
      chatId: CHAT,
      senderHandle: PARENT_A,
      senderUserId: a.userId,
      senderFamilyId: a.familyId,
      coveringFamilyId: a.familyId,
      text: 'Sunday it is, lock it in Hale',
      messageId: `m-${now.getTime()}`,
    });
    return { lock, picnic };
  }

  it('at night the lock places the plan but texts no household that did not write', async () => {
    const { lock, picnic } = await lockAt(NIGHT);
    expect((await planRow(picnic.id))?.startsAt).toEqual(new Date(SUNDAY_14));
    expect(lock.texted).toEqual([]);
  });

  it('by day the yes household gets its one OK ask (positive control)', async () => {
    const { lock } = await lockAt(NOW);
    expect(lock.texted.map((line) => line.to)).toEqual([PARENT_A]);
    expect(lock.texted[0]?.body).toContain('calendar_ask');
  });
});
