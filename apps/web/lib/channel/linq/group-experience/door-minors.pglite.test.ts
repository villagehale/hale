import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { postgresGroupPlanCalendarWriter } from '../group-plan-rsvp/calendar';
import { createPostgresGroupPlanRsvpStore } from '../group-plan-rsvp/store';
import { fakeGroupPlanRsvpComposer } from '../group-plan-rsvp/voice-fake';
import type { PrivateAsideModel } from '../group-private-aside';
import { handleLinqGroupMessage } from '../inbound';
import type { SharedGroupReader } from '../shared-group-reading';
import { fakeSharedGroupComposer } from '../shared-group-voice-fake';
import { considerGroupExperience } from './inbound';
import type { GroupExperienceKind, GroupExperienceReading } from './reading';
import { createPostgresGroupExperienceStore } from './store';
import { fakeGroupExperienceComposer } from './voice-fake';

/**
 * VIL-689 · the gate's minor probes (11-12) as regressions: P2 (a plan's own calendar copy
 * silenced its tally), P4 (a co-parent's private question answered to the primary parent),
 * P5 (a guest's redelivered link posted twice), and one link post texting a household twice.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-door-minors';
const NOW = new Date('2026-11-12T16:00:00.000Z');
const PARENT_A = '+15555550111';
const COPARENT_A = '+15555550133';
const PARENT_B = '+15555550122';
const GUEST = '+15555550199';
const FROM = '+15555550100';
const SATURDAY_10 = '2026-11-14T10:00:00-05:00';

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
  ]) {
    vi.stubEnv(flag, 'true');
  }
});
afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table families, users, linq_shared_group_people, linq_multi_family_joins, linq_multi_family_members, linq_group_experience, linq_group_plans, audit_log, channel_messages cascade',
  );
});

async function addUser(
  familyId: string,
  phone: string,
  name: string,
  role: 'primary_parent' | 'co_parent',
) {
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}`, name, timezone: 'America/Toronto' })
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
  await db.database.insert(schema.linqSharedGroupPeople).values({
    chatId: CHAT,
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    familyId,
    userId,
    firstName: name,
  });
  return userId;
}

async function seedFamily(phone: string, name: string) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const userId = await addUser(familyId, phone, name, 'primary_parent');
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

describe('P2: a plan on a household calendar does not silence its own tally', () => {
  it('the tally naming the plan still reaches the group', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const plans = createPostgresGroupPlanRsvpStore(db.database);
    const plan = await plans.createPlan({
      chatId: CHAT,
      familyId: a.familyId,
      title: 'picnic',
      startsAt: new Date(SATURDAY_10),
      location: null,
      rsvpDeadlineAt: null,
      createdByUserId: a.userId,
      expected: [],
      now: NOW,
    });
    await postgresGroupPlanCalendarWriter(db.database).write({
      planId: plan.id,
      chatId: CHAT,
      familyId: a.familyId,
      title: 'picnic',
      startsAt: new Date(SATURDAY_10),
      location: null,
    });
    await createPostgresGroupExperienceStore(db.database).upsertLive({
      chatId: CHAT,
      familyId: a.familyId,
      kind: 'rsvp_poll',
      subjectKey: plan.id,
      payload: { planId: plan.id },
      now: NOW,
    });
    const group: string[] = [];
    await considerGroupExperience(
      {
        database: db.database,
        now: NOW,
        send: async ({ text }) => {
          group.push(text);
          return { providerMessageId: `g-${group.length}` };
        },
        reader: { read: async () => reading({ kind: 'rsvp_tally' }) },
        composer: fakeGroupExperienceComposer({
          body: (input) => `${String(input.facts.title)} tally.`,
        }),
      },
      {
        chatId: CHAT,
        senderHandle: PARENT_B,
        senderUserId: null,
        senderFamilyId: null,
        coveringFamilyId: a.familyId,
        text: 'Hale where are we at?',
        messageId: 'm-1',
        planRef: { status: 'plan', planId: plan.id },
      },
    );
    expect(group).toEqual(['picnic tally.']);
  });

  it("control: a household's own private calendar title still silences the line", async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    await db.database.insert(schema.familyEvents).values({
      familyId: a.familyId,
      title: 'picnic',
      startsAt: new Date(SATURDAY_10),
      source: 'parent',
    });
    const plans = createPostgresGroupPlanRsvpStore(db.database);
    const plan = await plans.createPlan({
      chatId: CHAT,
      familyId: a.familyId,
      title: 'picnic',
      startsAt: new Date(SATURDAY_10),
      location: null,
      rsvpDeadlineAt: null,
      createdByUserId: a.userId,
      expected: [],
      now: NOW,
    });
    await createPostgresGroupExperienceStore(db.database).upsertLive({
      chatId: CHAT,
      familyId: a.familyId,
      kind: 'rsvp_poll',
      subjectKey: plan.id,
      payload: { planId: plan.id },
      now: NOW,
    });
    const group: string[] = [];
    await considerGroupExperience(
      {
        database: db.database,
        now: NOW,
        send: async ({ text }) => {
          group.push(text);
          return { providerMessageId: `g-${group.length}` };
        },
        reader: { read: async () => reading({ kind: 'rsvp_tally' }) },
        composer: fakeGroupExperienceComposer({
          body: (input) => `${String(input.facts.title)} tally.`,
        }),
      },
      {
        chatId: CHAT,
        senderHandle: PARENT_B,
        senderUserId: null,
        senderFamilyId: null,
        coveringFamilyId: a.familyId,
        text: 'Hale where are we at?',
        messageId: 'm-2',
        planRef: { status: 'plan', planId: plan.id },
      },
    );
    expect(group).toEqual([]);
  });
});

const questionReader: SharedGroupReader = {
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

function asideModel(pick: (refs: string[]) => string[]): PrivateAsideModel {
  return {
    async read(input) {
      return pick(input.families.map((family) => family.ref));
    },
    async draft() {
      return { send: true, about: 'their own plan', text: 'aside-line' };
    },
  };
}

async function door(opts: {
  text: string;
  from: string;
  messageId: string;
  kind: GroupExperienceKind;
  others: string[];
  aside?: PrivateAsideModel;
}) {
  const group: string[] = [];
  const dm: { to: string; body: string }[] = [];
  const response = await handleLinqGroupMessage(
    {
      database: db.database,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      countOutcome: async () => {},
      enqueue: async () => {},
      now: () => NOW,
      sendGroupText: async ({ text: line }: { chatId: string; text: string }) => {
        group.push(line);
        return { providerMessageId: `g-${group.length}` };
      },
      oneToOne: {
        text: async ({ to, body }: { to: string; body: string }) => {
          dm.push({ to, body });
          return { providerMessageId: `dm-${dm.length}`, chatId: `dm-${dm.length}` };
        },
        link: async () => ({ providerMessageId: 'unused' }),
      },
      listChatHandles: async () => ({ status: 'ok', handles: [opts.from, ...opts.others] }),
      sharedGroupReader: questionReader,
      sharedGroupVoice: fakeSharedGroupComposer({ body: 'shared-reply-line' }),
      privateAsideModel: opts.aside ?? asideModel(() => []),
      groupPlanRsvpReader: { read: async () => ({ kind: 'none', confidence: 'high' }) },
      groupPlanRsvpComposer: fakeGroupPlanRsvpComposer(),
      groupExperienceReader: { read: async () => reading({ kind: opts.kind }) },
      groupExperienceComposer: fakeGroupExperienceComposer({
        body: (input) =>
          input.audience === 'group' ? `moment:${input.kind}` : `one-to-one:${input.kind}`,
      }),
    } as unknown as Parameters<typeof handleLinqGroupMessage>[0],
    {
      messageId: opts.messageId,
      chatId: CHAT,
      senderHandle: opts.from,
      text: opts.text,
      mediaCount: 0,
      receivedAt: NOW,
      otherHandles: opts.others,
      mentions: [],
      isGroup: true,
    },
  );
  return { body: (await response.json()) as Record<string, unknown>, group, dm };
}

describe("P4: a co-parent's private question", () => {
  it('is answered 1:1 to the co-parent who asked', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    await addUser(a.familyId, COPARENT_A, 'Cy', 'co_parent');
    const out = await door({
      text: 'does the snack have peanuts? our kid is allergic',
      from: COPARENT_A,
      messageId: 'm-p4',
      kind: 'private_question',
      others: [PARENT_A, PARENT_B],
    });
    expect(out.dm.map((line) => line.to)).toEqual([COPARENT_A]);
  });
});

describe("P5: Linq redelivers a guest's link post", () => {
  it('one group line, not two', async () => {
    await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const post = {
      text: 'camp https://park.example/camp $120',
      from: GUEST,
      messageId: 'm-guest-1',
      kind: 'link_facts' as const,
      others: [PARENT_A, PARENT_B],
    };
    const first = await door(post);
    const second = await door(post);
    expect([...first.group, ...second.group]).toEqual(['moment:link_facts']);
  });
});

describe('one link post texts each household 1:1 once', () => {
  it('the registration line and the private aside never both reach the same household', async () => {
    for (const [phone, name, kid] of [
      [PARENT_A, 'Ada', 'Zephyrina'],
      [PARENT_B, 'Bao', 'Quillon'],
    ] as const) {
      const { familyId } = await seedFamily(phone, name);
      // Each household holds a private fact, so the aside has something to say to both.
      await db.database
        .insert(schema.children)
        .values({ familyId, name: kid, dateOfBirth: '2021-03-01' });
    }
    const out = await door({
      text: 'this camp looks good https://park.example/camp $120',
      from: PARENT_A,
      messageId: 'm-link-1',
      kind: 'link_facts',
      others: [PARENT_B],
      aside: asideModel((refs) => refs),
    });
    const perPhone = new Map<string, number>();
    for (const line of out.dm) perPhone.set(line.to, (perPhone.get(line.to) ?? 0) + 1);
    expect([...perPhone.values()].every((count) => count === 1)).toBe(true);
    expect(perPhone.size).toBe(2);
  });
});
