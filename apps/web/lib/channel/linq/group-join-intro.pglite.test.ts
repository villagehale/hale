import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  GROUP_JOIN_INTRO_TEMPLATE,
  groupJoinIntroDedupeKey,
  introduceHouseholdGroup,
  introduceOrAskRoster,
} from './group-join-intro';
import type { GroupOnboardingLine } from './group-onboarding-line-input';
import { fakeGroupOnboardingComposer } from './group-onboarding-voice-fake';
import type { LinqInboundText } from './payload';
import { type ListChatHandles, ejectHouseholdGroup, startGroupRoster } from './roster';
import type { RosterReading } from './roster-reading';
import { takeRosterTurn } from './roster-turn';

/**
 * VIL-727 — the join intro on a household group, over real Postgres.
 *
 * Lit, the line Hale says when it joins is the join intro: the ground rules code checked
 * are true today, plus the who's-who ask when someone needs asking (and then the roster
 * bookkeeping roster_ask does). Once per join; a model that cannot write it sends nothing
 * and pages #ops. Dark, the roster ask is unchanged.
 *
 * WHAT IS FAKED, and only this: the composer (`fakeGroupOnboardingComposer`, which tests
 * plumbing and never judges prose; the words are the eval's) and Linq's send.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const HALE = '+14165550100';
const PARENT = '+14165550111';
const DAD = '+14165550131';
const GRAN = '+14165550132';
const FRIEND = '+14165550133';
const NOW = new Date('2026-11-20T18:00:00.000Z');
const LATER = new Date('2026-11-22T18:00:00.000Z');
const CHAT = 'chat-family-group';

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
  vi.stubEnv('LINQ_FROM_E164', HALE);
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_TURN_AI_ENABLED', 'true');
  vi.stubEnv('GROUP_MAIL_NOTICE_ENABLED', '');
  vi.stubEnv('GROUP_JOIN_INTRO_ENABLED', 'true');
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
  await db.exec('truncate table linq_group_rosters cascade');
});

function wire() {
  const sent: Array<{ chatId: string; text: string }> = [];
  const send = async (input: { chatId: string; text: string }) => {
    sent.push({ chatId: input.chatId, text: input.text });
    return { providerMessageId: `out-${sent.length}` };
  };
  return { send, sent };
}

async function seedHousehold(phone: string, name: string) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const userId = await seedParent(familyId, phone, name, 'primary_parent');
  return { familyId, userId };
}

async function seedParent(
  familyId: string,
  phone: string,
  name: string,
  role: 'primary_parent' | 'co_parent',
) {
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${name}`, name: `${name} Example` })
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

async function roster(handles: string[], now = NOW) {
  const list: ListChatHandles = async () => ({ status: 'ok', handles, isGroup: true });
  return startGroupRoster(db.database, {
    chatId: CHAT,
    source: 'added_to_existing',
    now,
    listHandles: list,
  });
}

async function rosterRow() {
  const [row] = await db.database
    .select()
    .from(schema.linqGroupRosters)
    .where(eq(schema.linqGroupRosters.chatId, CHAT));
  return row;
}

async function memberStatus(phone: string) {
  const [row] = await db.database
    .select({ status: schema.linqGroupRosterMembers.status })
    .from(schema.linqGroupRosterMembers)
    .where(
      and(
        eq(schema.linqGroupRosterMembers.chatId, CHAT),
        eq(schema.linqGroupRosterMembers.phoneE164Hash, phoneBlindIndex(phone)),
      ),
    );
  return row?.status ?? null;
}

async function outbound() {
  return db.database
    .select({
      templateKey: schema.channelMessages.templateKey,
      dedupeKey: schema.channelMessages.dedupeKey,
      providerChatId: schema.channelMessages.providerChatId,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.direction, 'out'));
}

async function audits(verb: string) {
  return db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.actionTaken, verb));
}

function introCall(voice: ReturnType<typeof fakeGroupOnboardingComposer>): GroupOnboardingLine {
  const call = voice.calls.find((entry) => entry.input.kind === 'join_intro');
  if (!call) throw new Error('no join_intro was composed');
  return call.input;
}

describe('the join intro, lit', () => {
  it('says the ground rules and asks the people Hale does not know, once, in one line', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Riley');
    await roster([PARENT, DAD, GRAN, FRIEND]);
    const voice = fakeGroupOnboardingComposer();
    const { send, sent } = wire();

    const said = await introduceOrAskRoster(db.database, { chatId: CHAT, now: NOW, voice, send });

    expect(said).toMatchObject({ outcome: 'group_intro_sent', asked: 3 });
    expect(sent).toHaveLength(1);
    const input = introCall(voice);
    expect(input.skill).toBe('group-join-intro');
    expect(input.questions).toBe(1);
    expect(input.mustMention).toEqual(['Hale', 'Riley']);
    expect(input.facts).toMatchObject({
      audience: 'household',
      knownParentName: 'Riley',
      ask: 'who_in_family',
      claims: [
        'reads_this_chat',
        'email_never_shown',
        'speaks_when_called',
        'anyone_can_remove',
      ],
    });
    expect(voice.calls.some((entry) => entry.input.kind === 'roster_ask')).toBe(false);

    const row = await rosterRow();
    expect(row?.askedAt).toEqual(NOW);
    for (const phone of [DAD, GRAN, FRIEND]) expect(await memberStatus(phone)).toBe('asked');
    expect(await memberStatus(PARENT)).toBe('known_parent');
    expect(await outbound()).toEqual([
      {
        templateKey: GROUP_JOIN_INTRO_TEMPLATE,
        dedupeKey: groupJoinIntroDedupeKey(CHAT, row?.rosterFetchedAt ?? null),
        providerChatId: CHAT,
      },
    ]);
    const asked = await audits('linq_group_roster_asked');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.after).toEqual({ asked: 3, source: 'composed', via: 'join_intro' });
    const sentRows = await audits('sms_reply_sent');
    expect(sentRows.map((r) => r.after)).toEqual([
      { templateKey: GROUP_JOIN_INTRO_TEMPLATE, source: 'composed' },
    ]);
    expect(familyId).toBeTruthy();
  });

  it('introduces itself with no question where everyone is already known', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Riley');
    await seedParent(familyId, DAD, 'Morgan', 'co_parent');
    const settled = await roster([PARENT, DAD]);
    expect(settled).toMatchObject({ outcome: 'roster_matched', status: 'confirmed' });
    const voice = fakeGroupOnboardingComposer();
    const { send, sent } = wire();

    const said = await introduceOrAskRoster(db.database, { chatId: CHAT, now: NOW, voice, send });

    expect(said).toMatchObject({ outcome: 'group_intro_sent', asked: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).not.toContain('?');
    const input = introCall(voice);
    expect(input.questions).toBe(0);
    expect(input.facts).toMatchObject({ ask: 'none' });
    // Two parents and Hale: too small a group for anyone to remove a member.
    expect(input.facts.claims).not.toContain('anyone_can_remove');
    expect((await rosterRow())?.askedAt).toBeNull();
    expect(await audits('linq_group_roster_asked')).toHaveLength(0);
  });

  it('says it once per join: the second trigger for the same join sends nothing', async () => {
    await seedHousehold(PARENT, 'Riley');
    await roster([PARENT, DAD, GRAN]);
    const voice = fakeGroupOnboardingComposer();
    const { send, sent } = wire();

    await introduceOrAskRoster(db.database, { chatId: CHAT, now: NOW, voice, send });
    const again = await introduceHouseholdGroup(db.database, {
      chatId: CHAT,
      now: NOW,
      voice,
      send,
    });

    expect(again).toEqual({ outcome: 'group_intro_already' });
    expect(sent).toHaveLength(1);
    expect(voice.calls.filter((entry) => entry.input.kind === 'join_intro')).toHaveLength(1);
    expect(await outbound()).toHaveLength(1);
  });

  it('introduces itself again when it is added back after being removed', async () => {
    await seedHousehold(PARENT, 'Riley');
    await roster([PARENT, DAD, GRAN]);
    const voice = fakeGroupOnboardingComposer();
    const { send, sent } = wire();
    await introduceOrAskRoster(db.database, { chatId: CHAT, now: NOW, voice, send });

    await ejectHouseholdGroup(db.database, { chatId: CHAT, now: NOW });
    await roster([PARENT, DAD, GRAN, FRIEND], LATER);
    const back = await introduceOrAskRoster(db.database, {
      chatId: CHAT,
      now: LATER,
      voice,
      send,
    });

    expect(back).toMatchObject({ outcome: 'group_intro_sent' });
    expect(sent).toHaveLength(2);
    const keys = (await outbound()).map((row) => row.dedupeKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('sends nothing, audits, and pages #ops when the model cannot write it; the next try can', async () => {
    await seedHousehold(PARENT, 'Riley');
    await roster([PARENT, DAD, GRAN]);
    const { send, sent } = wire();

    const failed = await introduceOrAskRoster(db.database, {
      chatId: CHAT,
      now: NOW,
      voice: fakeGroupOnboardingComposer({ fail: true }),
      send,
    });

    expect(failed).toMatchObject({
      outcome: 'group_intro_not_sent',
      notice: { outcome: 'group_line_unsent', fallback: 'model_failed' },
    });
    expect(sent).toHaveLength(0);
    expect(await outbound()).toHaveLength(0);
    const unsent = await audits('group_line_unsent');
    expect(unsent.map((r) => r.after)).toEqual([
      { kind: 'join_intro', fallback: 'model_failed', templateKey: GROUP_JOIN_INTRO_TEMPLATE },
    ]);
    expect(await memberStatus(DAD)).toBe('proposed');
    expect((await rosterRow())?.askedAt).toBeNull();

    const retried = await introduceOrAskRoster(db.database, {
      chatId: CHAT,
      now: NOW,
      voice: fakeGroupOnboardingComposer(),
      send,
    });
    expect(retried).toMatchObject({ outcome: 'group_intro_sent', asked: 2 });
    expect(sent).toHaveLength(1);
  });

  it('pages #ops once, naming the line and never the family, when the model cannot write it', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://hooks.example.test/ops');
    const pages: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        pages.push(String(init?.body ?? ''));
        return new Response('ok', { status: 200 });
      }),
    );
    await seedHousehold(PARENT, 'Riley');
    await roster([PARENT, DAD, GRAN]);
    const { send, sent } = wire();

    await introduceOrAskRoster(db.database, {
      chatId: CHAT,
      now: NOW,
      voice: fakeGroupOnboardingComposer({ fail: true }),
      send,
    });

    expect(sent).toHaveLength(0);
    expect(pages).toHaveLength(1);
    const page = JSON.parse(pages[0] ?? '{}') as { text?: string };
    expect(page.text).toContain('join_intro');
    expect(page.text).not.toContain('Riley');
  });

  it('refuses a line that asks when it should not, and one with a link: nothing is sent', async () => {
    await seedHousehold(PARENT, 'Riley');
    await roster([PARENT, DAD, GRAN]);
    const { send, sent } = wire();

    const twoQuestions = await introduceHouseholdGroup(db.database, {
      chatId: CHAT,
      now: NOW,
      voice: fakeGroupOnboardingComposer({ body: 'Hale for Riley? Who are you? Which kid?' }),
      send,
    });
    const linked = await introduceHouseholdGroup(db.database, {
      chatId: CHAT,
      now: NOW,
      voice: fakeGroupOnboardingComposer({
        body: 'Hale here for Riley, see villagehale.com. Who are you?',
      }),
      send,
    });

    for (const outcome of [twoQuestions, linked]) {
      expect(outcome).toMatchObject({
        outcome: 'group_intro_not_sent',
        notice: { outcome: 'group_line_unsent', fallback: 'unusable' },
      });
    }
    expect(sent).toHaveLength(0);
  });

  it('leaves out what the live flags make untrue', async () => {
    vi.stubEnv('LINQ_GROUP_TURN_AI_ENABLED', '');
    vi.stubEnv('GROUP_MAIL_NOTICE_ENABLED', 'true');
    await seedHousehold(PARENT, 'Riley');
    await roster([PARENT, DAD, GRAN, FRIEND]);
    const voice = fakeGroupOnboardingComposer();
    const { send } = wire();

    await introduceOrAskRoster(db.database, { chatId: CHAT, now: NOW, voice, send });

    expect(introCall(voice).facts.claims).toEqual(['reads_this_chat', 'anyone_can_remove']);
  });

  it('is not said in a chat whose roster has no family yet', async () => {
    await roster([DAD, GRAN]);
    const voice = fakeGroupOnboardingComposer();
    const { send, sent } = wire();

    const said = await introduceOrAskRoster(db.database, { chatId: CHAT, now: NOW, voice, send });

    expect(said).toEqual({ outcome: 'group_intro_not_ready', status: 'no_family' });
    expect(sent).toHaveLength(0);
    expect(voice.calls).toHaveLength(0);
  });

  it('is the line a later group message sets off when the join line never went out', async () => {
    await seedHousehold(PARENT, 'Riley');
    await roster([PARENT, DAD, GRAN]);
    const voice = fakeGroupOnboardingComposer();
    const { send, sent } = wire();
    const message: LinqInboundText = {
      messageId: 'in-1',
      chatId: CHAT,
      senderHandle: GRAN,
      text: 'hello everyone',
      mediaCount: 0,
      receivedAt: NOW,
      sentAt: NOW,
      otherHandles: [],
      mentions: [],
    };

    const turn = await takeRosterTurn(db.database, message, {
      now: NOW,
      voice,
      send,
      readReply: async (): Promise<RosterReading> => ({ kind: 'unclear' }),
      recordInbound: async () => 'row-1',
    });

    expect(turn).toMatchObject({ handled: true, outcome: 'group_intro_sent', count: 'intake' });
    expect(sent).toHaveLength(1);
    expect(introCall(voice).facts).toMatchObject({ ask: 'who_in_family' });
  });
});

describe('the join intro, dark', () => {
  it('leaves the roster ask exactly as it was', async () => {
    vi.stubEnv('GROUP_JOIN_INTRO_ENABLED', '');
    await seedHousehold(PARENT, 'Riley');
    await roster([PARENT, DAD, GRAN]);
    const voice = fakeGroupOnboardingComposer();
    const { send, sent } = wire();

    const said = await introduceOrAskRoster(db.database, { chatId: CHAT, now: NOW, voice, send });

    expect(said).toMatchObject({ outcome: 'roster_asked' });
    expect(sent).toHaveLength(1);
    expect(voice.calls.map((entry) => entry.input.kind)).toEqual(['roster_ask']);
    expect(voice.calls[0]?.input.skill).toBe('group-onboarding-voice');
    expect((await outbound()).map((row) => row.templateKey)).toEqual(['linq:roster_ask']);
    expect((await audits('linq_group_roster_asked'))[0]?.after).toEqual({
      asked: 2,
      source: 'composed',
    });
  });

  it('stays off for a value that is not exactly true', async () => {
    for (const value of ['TRUE', 'true\n', ' true', 'on', '1']) {
      vi.stubEnv('GROUP_JOIN_INTRO_ENABLED', value);
      await seedHousehold(PARENT, 'Riley');
      await roster([PARENT, DAD, GRAN]);
      const voice = fakeGroupOnboardingComposer();
      const { send } = wire();

      const said = await introduceOrAskRoster(db.database, {
        chatId: CHAT,
        now: NOW,
        voice,
        send,
      });

      expect(said.outcome).toBe('roster_asked');
      expect(voice.calls.map((entry) => entry.input.kind)).toEqual(['roster_ask']);
      await db.exec('truncate table families, users cascade');
      await db.exec('truncate table linq_group_rosters cascade');
      await db.exec('truncate table channel_messages cascade');
    }
  });
});
