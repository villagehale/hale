import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { fakeGroupPlanRsvpComposer } from '../group-plan-rsvp/voice-fake';
import { considerGroupPlanRsvp } from '../group-plan-rsvp/inbound';
import type { GroupPlanRsvpReading } from '../group-plan-rsvp/reading';
import { createPostgresGroupPlanRsvpStore } from '../group-plan-rsvp/store';
import { considerGroupExperience } from './inbound';
import type { GroupExperienceReading } from './reading';
import { createPostgresGroupExperienceStore } from './store';
import { fakeGroupExperienceComposer } from './voice-fake';

/**
 * VIL-399 scenes 03 and 04 through the production wiring: a locked time is the time the
 * reader resolved on a clock (never a label parsed as a date), and a plan reaches a
 * household's calendar only for a household that said yes, after that household's own OK
 * (the VIL-503 1:1 ask), never silently.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-exp-lock';
const NOW = new Date('2026-11-12T16:00:00.000Z');
const PARENT_A = '+15555550111';
const PARENT_B = '+15555550122';
const SATURDAY_10 = '2026-11-14T10:00:00-05:00';
const SUNDAY_10 = '2026-11-15T10:00:00-05:00';

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
  vi.stubEnv('GROUP_POLLS_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_PLAN_RSVP_CALENDAR_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table families, users, linq_shared_group_people, linq_multi_family_joins, linq_multi_family_members, linq_group_experience, linq_group_plans, audit_log, channel_messages cascade',
  );
});

async function seedFamily(phone: string, name: string) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}`, name, timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
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
  // A live seat is what makes this parent's household the one a calendar OK may touch.
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

/** Ada's household said yes, Bao's said no, to a plan with no time yet (or `startsAt`). */
async function planWithAnswers(startsAt: Date | null) {
  const a = await seedFamily(PARENT_A, 'Ada');
  const b = await seedFamily(PARENT_B, 'Bao');
  const plans = createPostgresGroupPlanRsvpStore(db.database);
  const plan = await plans.createPlan({
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
  for (const [who, response] of [
    [a, 'yes'],
    [b, 'no'],
  ] as const) {
    await plans.upsertRsvp({
      planId: plan.id,
      memberKey: `key-${who.userId}`,
      displayName: who === a ? 'Ada' : 'Bao',
      householdLabel: null,
      userId: who.userId,
      haleCustomer: true,
      response,
      headcount: 1,
      source: 'text',
      coversKeys: [],
      verbatim: null,
      now: NOW,
    });
  }
  return { a, b, plan };
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

function ports(kind: GroupExperienceReading) {
  const group: string[] = [];
  const texted: string[] = [];
  return {
    group,
    texted,
    ports: {
      database: db.database,
      now: NOW,
      send: async ({ text }: { chatId: string; text: string }) => {
        group.push(text);
        return { providerMessageId: `g-${group.length}` };
      },
      oneToOne: {
        text: async ({ to }: { to: string; body: string }) => {
          texted.push(to);
          return { providerMessageId: `dm-${texted.length}`, chatId: `dm-${texted.length}` };
        },
        link: async () => ({ providerMessageId: 'unused' }),
      },
      calendarComposer: fakeGroupPlanRsvpComposer(),
      reader: { read: async () => kind },
      composer: fakeGroupExperienceComposer(),
    },
  };
}

const turnInput = (a: { familyId: string; userId: string }) => ({
  chatId: CHAT,
  senderHandle: PARENT_A,
  senderUserId: a.userId,
  senderFamilyId: a.familyId,
  coveringFamilyId: a.familyId,
  text: 'Hale lock it in',
  messageId: 'm-1',
});

async function seedTimePoll(planId: string, starts: readonly (string | null)[]) {
  await createPostgresGroupExperienceStore(db.database).upsertLive({
    chatId: CHAT,
    familyId: (await db.database.select().from(schema.families).limit(1))[0]?.id as string,
    kind: 'time_poll',
    subjectKey: planId,
    payload: {
      planId,
      options: [
        { key: 'a', text: 'Saturday 10', choiceValue: 'a', startsAt: starts[0] ?? null },
        { key: 'b', text: 'Sunday 10', choiceValue: 'b', startsAt: starts[1] ?? null },
      ],
      votes: { [PARENT_A]: 'a', [PARENT_B]: 'a' },
    },
    now: NOW,
  });
}

async function planStart(planId: string) {
  const [row] = await db.database
    .select({ startsAt: schema.linqGroupPlans.startsAt })
    .from(schema.linqGroupPlans)
    .where(eq(schema.linqGroupPlans.id, planId));
  return row?.startsAt ?? null;
}

async function calendarCopies() {
  return db.database
    .select({ familyId: schema.familyEvents.familyId, startsAt: schema.familyEvents.startsAt })
    .from(schema.familyEvents);
}

async function calendarAsks() {
  return db.database
    .select({
      familyId: schema.linqGroupPlanCalendarConsents.familyId,
      status: schema.linqGroupPlanCalendarConsents.status,
    })
    .from(schema.linqGroupPlanCalendarConsents);
}

describe('VIL-399 scene 03: locking the winning time', () => {
  it('a winning label with no resolved time is never parsed into a date', async () => {
    const { a, plan } = await planWithAnswers(null);
    await seedTimePoll(plan.id, [null, null]);
    const w = ports(reading({ kind: 'time_lock' }));
    const out = await considerGroupExperience(w.ports, turnInput(a));
    expect(out).toMatchObject({ handled: true, outcome: 'group_experience_spoken' });
    expect(w.group).toHaveLength(1);
    expect(await planStart(plan.id)).toBeNull();
    expect(await calendarCopies()).toEqual([]);
    expect(await calendarAsks()).toEqual([]);
  });

  it('the reader-resolved time becomes the plan time; only the yes household is asked', async () => {
    const { a, plan } = await planWithAnswers(null);
    await seedTimePoll(plan.id, [SATURDAY_10, SUNDAY_10]);
    const w = ports(reading({ kind: 'time_lock' }));
    await considerGroupExperience(w.ports, turnInput(a));
    expect((await planStart(plan.id))?.toISOString()).toBe(new Date(SATURDAY_10).toISOString());
    // Asked 1:1, not written: the household's OK comes first.
    expect(await calendarAsks()).toEqual([{ familyId: a.familyId, status: 'asked' }]);
    expect(w.texted).toEqual([PARENT_A]);
    expect(await calendarCopies()).toEqual([]);
  });
});

describe('VIL-399 scene 04: the tally never writes a calendar on its own', () => {
  it('a settled tally asks the yes household and writes nothing yet', async () => {
    const { a, b, plan } = await planWithAnswers(new Date(SATURDAY_10));
    await createPostgresGroupExperienceStore(db.database).upsertLive({
      chatId: CHAT,
      familyId: a.familyId,
      kind: 'rsvp_poll',
      subjectKey: plan.id,
      payload: { planId: plan.id },
      now: NOW,
    });
    const w = ports(reading({ kind: 'rsvp_tally' }));
    await considerGroupExperience(w.ports, {
      ...turnInput(a),
      planRef: { status: 'plan', planId: plan.id },
    });
    expect(w.group).toHaveLength(1);
    expect(await calendarCopies()).toEqual([]);
    expect((await calendarAsks()).map((row) => row.familyId)).not.toContain(b.familyId);
  });

  it('a yes RSVP read from the group takes the household OK path; a no takes none', async () => {
    const { a, b, plan } = await planWithAnswers(new Date(SATURDAY_10));
    await db.exec('truncate table linq_group_plan_rsvps cascade');
    const texted: string[] = [];
    const answer = (response: 'yes' | 'no'): GroupPlanRsvpReading => ({
      intent: 'rsvp',
      planTitle: null,
      startsAt: null,
      location: null,
      deadline: null,
      response,
      headcount: 1,
      householdLabel: null,
      coversNames: [],
      confidence: 'high',
      planKey: 'p1',
      replacesPlanKey: null,
      addressed: false,
    });
    const portsFor = (response: 'yes' | 'no') => ({
      database: db.database,
      now: NOW,
      send: async () => ({ providerMessageId: 'g-1' }),
      reader: { read: async () => answer(response) },
      composer: fakeGroupPlanRsvpComposer(),
      oneToOne: {
        text: async ({ to }: { to: string; body: string }) => {
          texted.push(to);
          return { providerMessageId: `dm-${texted.length}`, chatId: `dm-${texted.length}` };
        },
        link: async () => ({ providerMessageId: 'unused' }),
      },
    });
    await considerGroupPlanRsvp(portsFor('yes'), {
      chatId: CHAT,
      senderHandle: PARENT_A,
      senderUserId: a.userId,
      text: 'we are in',
      tapback: null,
    });
    const afterYes = [...texted];
    await considerGroupPlanRsvp(portsFor('no'), {
      chatId: CHAT,
      senderHandle: PARENT_B,
      senderUserId: b.userId,
      text: 'we cannot make it',
      tapback: null,
    });
    expect(plan.id).toBeTruthy();
    expect(await calendarAsks()).toEqual([{ familyId: a.familyId, status: 'asked' }]);
    expect(afterYes).toEqual([PARENT_A]);
    expect(texted).toEqual([PARENT_A]);
    expect(await calendarCopies()).toEqual([]);
  });
});
