import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { fakeGroupOnboardingComposer } from './group-onboarding-voice-fake';
import type { LinqInboundText } from './payload';
import { type ListChatHandles, startGroupRoster } from './roster';
import { askMember, askRoster, sayNoFamilyYet } from './roster-ask';
import type { RosterReading } from './roster-reading';
import { takeRosterTurn } from './roster-turn';
import { LinqSendError } from './transport';

/**
 * Group onboarding v2, PR B: one model-written ask per roster, a seat only on the
 * member's own reply, one re-ask for a reply the injected reader cannot read, and a named
 * outcome when the model could not write the line. The fake composer tests the plumbing.
 * Tests pass the reading; production asks the model.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const HALE = '+14165550100';
const PARENT = '+14165550111';
const DAD = '+14165550131';
const GRAN = '+14165550132';
const LATE = '+14165550133';
const OTHER_PARENT = '+14165550141';
const NOW = new Date('2026-10-06T18:00:00.000Z');
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
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
  await db.exec('truncate table linq_group_rosters cascade');
});

interface Sent {
  chatId: string;
  text: string;
  replyTo?: string;
}

function wire(options: { failFirst?: boolean } = {}) {
  const sent: Sent[] = [];
  let calls = 0;
  const send = async (input: Sent) => {
    calls += 1;
    if (options.failFirst && calls === 1) {
      throw new LinqSendError('linq_send_failed', 503, false);
    }
    sent.push(input);
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
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${name}`, name: `${name} Example` })
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
  return { familyId, userId };
}

async function roster(handles: string[]) {
  const list: ListChatHandles = async () => ({ status: 'ok', handles, isGroup: true });
  return startGroupRoster(db.database, {
    chatId: CHAT,
    source: 'added_to_existing',
    now: NOW,
    listHandles: list,
  });
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
      status: schema.channelMessages.status,
      direction: schema.channelMessages.direction,
      parentUserId: schema.channelMessages.parentUserId,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.direction, 'out'));
}

async function audits(verb: string) {
  return db.database
    .select({ after: schema.auditLog.after, actor: schema.auditLog.actor })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.actionTaken, verb));
}

function inbound(sender: string, text: string, messageId = `in-${text.length}`): LinqInboundText {
  return {
    messageId,
    chatId: CHAT,
    senderHandle: sender,
    text,
    mediaCount: 0,
    receivedAt: NOW,
    otherHandles: [],
  };
}

function fixtureReading(text: string): RosterReading {
  if (text === "I'm his dad") {
    return { kind: 'role', role: 'parent', parentRole: 'father', relation: null };
  }
  if (text === 'grandma here!') {
    return { kind: 'role', role: 'grandparent', parentRole: null, relation: null };
  }
  if (text === 'not family, just a friend') {
    return { kind: 'role', role: 'not_family', parentRole: null, relation: null };
  }
  if (text === "I'm your aunt") {
    return { kind: 'role', role: 'extended', parentRole: null, relation: 'aunt' };
  }
  return { kind: 'unclear' };
}

function turnPorts(
  voice: ReturnType<typeof fakeGroupOnboardingComposer> | undefined,
  send: ReturnType<typeof wire>['send'],
) {
  const recorded: Array<{ messageId: string; userId: string }> = [];
  return {
    recorded,
    ports: {
      now: NOW,
      voice,
      readReply: async (text: string) => fixtureReading(text),
      send,
      recordInbound: async (
        message: LinqInboundText,
        owner: { familyId: string; userId: string },
      ) => {
        recorded.push({ messageId: message.messageId, userId: owner.userId });
        return `row-${recorded.length}`;
      },
    },
  };
}

describe('askRoster', () => {
  it('asks the whole roster once, in a model-written line that names the known parent', async () => {
    const { familyId, userId } = await seedHousehold(PARENT, 'Riley');
    await roster([PARENT, DAD, GRAN]);
    const voice = fakeGroupOnboardingComposer();
    const { send, sent } = wire();

    const asked = await askRoster(db.database, { chatId: CHAT, now: NOW, voice, send });
    expect(asked).toEqual({
      outcome: 'roster_asked',
      notice: { outcome: 'sent', source: 'composed' },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe(CHAT);
    expect(voice.calls).toHaveLength(1);
    const input = voice.calls[0]?.input;
    expect(input).toMatchObject({
      skill: 'group-onboarding-voice',
      kind: 'roster_ask',
      address: 'vous',
      questions: 1,
      facts: { knownParentName: 'Riley', rosterSize: 3 },
    });
    expect(input?.mustMention).toEqual(['Hale', 'Riley']);
    expect(sent[0]?.text).toContain('Riley');

    expect(await outbound()).toEqual([
      {
        templateKey: 'linq:roster_ask',
        dedupeKey: `linq:roster_ask:${CHAT}`,
        providerChatId: CHAT,
        status: 'sent',
        direction: 'out',
        parentUserId: userId,
      },
    ]);
    expect(await memberStatus(DAD)).toBe('asked');
    expect(await memberStatus(GRAN)).toBe('asked');
    expect(await memberStatus(PARENT)).toBe('known_parent');
    const [rosterRow] = await db.database.select().from(schema.linqGroupRosters);
    expect(rosterRow?.askedAt).toEqual(NOW);
    expect((await audits('linq_group_roster_asked')).map((row) => row.after)).toEqual([
      { asked: 2, source: 'composed' },
    ]);
    expect((await audits('sms_reply_sent')).map((row) => row.after)).toEqual([
      { templateKey: 'linq:roster_ask', source: 'composed' },
    ]);
    void familyId;

    const again = await askRoster(db.database, { chatId: CHAT, now: NOW, voice, send });
    expect(again).toEqual({ outcome: 'roster_already_asked' });
    expect(sent).toHaveLength(1);
  });

  it('sends nothing when the model cannot write the ask, and does not spend the claim', async () => {
    await seedHousehold(PARENT, 'Riley');
    await roster([PARENT, DAD]);
    const { send, sent } = wire();

    const asked = await askRoster(db.database, {
      chatId: CHAT,
      now: NOW,
      voice: fakeGroupOnboardingComposer({ fail: true }),
      send,
    });
    expect(asked).toEqual({
      outcome: 'roster_ask_not_sent',
      notice: { outcome: 'group_line_unsent', fallback: 'model_failed' },
    });
    expect(sent).toEqual([]);
    expect(await memberStatus(DAD)).toBe('proposed');
    expect((await audits('group_line_unsent')).map((row) => row.after)).toEqual([
      { kind: 'roster_ask', fallback: 'model_failed', templateKey: 'linq:roster_ask' },
    ]);
    expect(await audits('sms_reply_sent')).toEqual([]);
    expect(await audits('group_line_locked_fallback')).toEqual([]);
  });

  it('releases the claim when Linq refuses the send, so the next inbound asks again', async () => {
    await seedHousehold(PARENT, 'Riley');
    await roster([PARENT, DAD]);
    const voice = fakeGroupOnboardingComposer();
    const { send, sent } = wire({ failFirst: true });

    const failed = await askRoster(db.database, { chatId: CHAT, now: NOW, voice, send });
    expect(failed).toEqual({
      outcome: 'roster_ask_not_sent',
      notice: { outcome: 'not_sent', code: 'linq_send_failed' },
    });
    expect(await memberStatus(DAD)).toBe('proposed');
    expect(await outbound()).toEqual([
      expect.objectContaining({
        templateKey: 'linq:roster_ask',
        dedupeKey: null,
        status: 'failed',
      }),
    ]);

    const retried = await askRoster(db.database, { chatId: CHAT, now: NOW, voice, send });
    expect(retried).toMatchObject({ outcome: 'roster_asked' });
    expect(sent).toHaveLength(1);
    expect(await memberStatus(DAD)).toBe('asked');
  });
});

describe('sayNoFamilyYet', () => {
  it('says one model-written line into a chat with no known parent, then stays quiet', async () => {
    expect(await roster([DAD, GRAN])).toMatchObject({ outcome: 'roster_no_family' });
    const voice = fakeGroupOnboardingComposer();
    const { send, sent } = wire();

    const first = await sayNoFamilyYet(db.database, { chatId: CHAT, now: NOW, voice, send });
    expect(first).toEqual({
      outcome: 'roster_no_family',
      notice: { outcome: 'sent', source: 'composed' },
    });
    expect(voice.calls[0]?.input).toMatchObject({
      kind: 'no_family_yet',
      mustMention: ['Hale'],
      questions: 0,
    });
    const second = await sayNoFamilyYet(db.database, { chatId: CHAT, now: NOW, voice, send });
    expect(second).toEqual({ outcome: 'roster_no_family_quiet' });
    expect(sent).toHaveLength(1);
  });

  it('sends nothing when the model cannot write it, and tries again next time', async () => {
    await roster([DAD]);
    const { send, sent } = wire();

    const unsent = await sayNoFamilyYet(db.database, {
      chatId: CHAT,
      now: NOW,
      voice: fakeGroupOnboardingComposer({ fail: true }),
      send,
    });
    expect(unsent).toEqual({
      outcome: 'roster_no_family',
      notice: { outcome: 'group_line_unsent', fallback: 'model_failed' },
    });
    expect(sent).toEqual([]);
    const retried = await sayNoFamilyYet(db.database, {
      chatId: CHAT,
      now: NOW,
      voice: fakeGroupOnboardingComposer(),
      send,
    });
    expect(retried).toMatchObject({ outcome: 'roster_no_family', notice: { outcome: 'sent' } });
  });
});

describe('askMember', () => {
  it('asks someone added later, once, and does not seat them', async () => {
    await seedHousehold(PARENT, 'Riley');
    await roster([PARENT, DAD]);
    const voice = fakeGroupOnboardingComposer();
    const { send, sent } = wire();

    const asked = await askMember(db.database, {
      chatId: CHAT,
      phone: LATE,
      now: NOW,
      voice,
      send,
    });
    expect(asked).toEqual({
      outcome: 'member_asked',
      notice: { outcome: 'sent', source: 'composed' },
    });
    expect(voice.calls[0]?.input).toMatchObject({
      kind: 'member_ask',
      facts: { knownParentName: 'Riley' },
    });
    expect(await memberStatus(LATE)).toBe('asked');
    expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
    expect(
      await askMember(db.database, { chatId: CHAT, phone: LATE, now: NOW, voice, send }),
    ).toEqual({
      outcome: 'member_already',
    });
    expect(sent).toHaveLength(1);
    expect((await outbound()).map((row) => row.dedupeKey)).toEqual([
      `linq:member_ask:${CHAT}:${phoneBlindIndex(LATE)}`,
    ]);
  });

  it('does not ask a parent of another family', async () => {
    await seedHousehold(PARENT, 'Riley');
    await seedHousehold(OTHER_PARENT, 'Elsewhere');
    await roster([PARENT, DAD]);
    const { send, sent } = wire();
    expect(
      await askMember(db.database, {
        chatId: CHAT,
        phone: OTHER_PARENT,
        now: NOW,
        voice: fakeGroupOnboardingComposer(),
        send,
      }),
    ).toEqual({ outcome: 'group_member_refused', reason: 'other_family' });
    expect(sent).toEqual([]);
    expect(await memberStatus(OTHER_PARENT)).toBe('refused');

    expect(
      await askMember(db.database, {
        chatId: CHAT,
        phone: OTHER_PARENT,
        now: NOW,
        voice: fakeGroupOnboardingComposer(),
        send,
      }),
    ).toEqual({ outcome: 'member_already' });
    expect(await audits('linq_group_member_refused')).toHaveLength(1);
  });
});

describe('takeRosterTurn', () => {
  async function askedFamily() {
    const household = await seedHousehold(PARENT, 'Riley');
    await roster([PARENT, DAD, GRAN]);
    const asking = wire();
    await askRoster(db.database, {
      chatId: CHAT,
      now: NOW,
      voice: fakeGroupOnboardingComposer(),
      send: asking.send,
    });
    return household;
  }

  it('seats the dad on his own reply and acknowledges him in a threaded group line', async () => {
    await askedFamily();
    const voice = fakeGroupOnboardingComposer();
    const { send, sent } = wire();
    const { ports, recorded } = turnPorts(voice, send);

    const turn = await takeRosterTurn(db.database, inbound(DAD, "I'm his dad", 'in-dad'), ports);
    expect(turn).toMatchObject({ handled: true, outcome: 'role_confirmed', count: 'intake' });
    expect(await memberStatus(DAD)).toBe('confirmed');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.replyTo).toBe('in-dad');
    expect(voice.calls[0]?.input).toMatchObject({
      kind: 'role_confirmed',
      facts: { roleWord: 'dad' },
      parentWords: "I'm his dad",
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.messageId).toBe('in-dad');
    const confirmations = (await outbound()).filter(
      (row) => row.templateKey === 'linq:role_confirmed',
    );
    expect(confirmations).toHaveLength(1);
  });

  it('re-asks once for a reply code cannot read, then stays quiet and seats nobody', async () => {
    await askedFamily();
    const voice = fakeGroupOnboardingComposer();
    const { send, sent } = wire();
    const { ports } = turnPorts(voice, send);

    const first = await takeRosterTurn(
      db.database,
      inbound(GRAN, "it's me, I do the school runs", 'in-1'),
      ports,
    );
    expect(first).toMatchObject({ handled: true, outcome: 'role_unclear' });
    expect(sent.map((s) => s.replyTo)).toEqual(['in-1']);
    expect(voice.calls[0]?.input.kind).toBe('role_reask');
    expect(await memberStatus(GRAN)).toBe('reasked');
    expect(await audits('linq_group_role_reasked')).toHaveLength(1);

    const second = await takeRosterTurn(
      db.database,
      inbound(GRAN, 'the one who carried them lol', 'in-2'),
      ports,
    );
    expect(second).toMatchObject({ handled: true, outcome: 'role_unclear_final' });
    expect(await memberStatus(GRAN)).toBe('reasked');
    expect(sent).toHaveLength(1);
    expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
    expect(await db.database.select().from(schema.consentRecords)).toEqual([]);
    expect(
      (
        await db.database.select({ role: schema.familyMembers.role }).from(schema.familyMembers)
      ).map((row) => row.role),
    ).toEqual(['primary_parent']);
  });

  it('asks a sender the roster has never seen before reading anything they said as a role', async () => {
    await askedFamily();
    const voice = fakeGroupOnboardingComposer();
    const { send, sent } = wire();
    const { ports } = turnPorts(voice, send);

    const turn = await takeRosterTurn(
      db.database,
      inbound(LATE, 'grandma here!', 'in-late'),
      ports,
    );
    expect(turn).toMatchObject({ handled: true, outcome: 'member_asked' });
    expect(await memberStatus(LATE)).toBe('asked');
    expect(voice.calls.map((call) => call.input.kind)).toEqual(['member_ask']);
    expect(sent).toHaveLength(1);
    expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
  });

  it('leaves a known parent’s message to the household router', async () => {
    await askedFamily();
    const { send, sent } = wire();
    const { ports } = turnPorts(fakeGroupOnboardingComposer(), send);
    expect(await takeRosterTurn(db.database, inbound(PARENT, 'who has pickup?'), ports)).toEqual({
      handled: false,
    });
    expect(sent).toEqual([]);
  });

  it('keeps the seat but sends no acknowledgement when the model cannot write it, and names that', async () => {
    const { familyId } = await askedFamily();
    const { send, sent } = wire();
    const { ports } = turnPorts(fakeGroupOnboardingComposer({ fail: true }), send);

    const turn = await takeRosterTurn(db.database, inbound(GRAN, 'grandma here!', 'in-g'), ports);
    expect(turn).toMatchObject({
      handled: true,
      outcome: 'role_confirmed',
      body: { notice: { outcome: 'group_line_unsent', fallback: 'model_failed' } },
    });
    expect(await memberStatus(GRAN)).toBe('confirmed');
    expect(sent).toEqual([]);
    const unsent = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, familyId),
          eq(schema.auditLog.actionTaken, 'group_line_unsent'),
        ),
      );
    expect(unsent.map((row) => row.after)).toEqual([
      { kind: 'role_confirmed', fallback: 'model_failed', templateKey: 'linq:role_confirmed' },
    ]);
  });

  it('seats an aunt as extended family, not as not family', async () => {
    await askedFamily();
    const voice = fakeGroupOnboardingComposer();
    const { send } = wire();
    const { ports } = turnPorts(voice, send);

    const turn = await takeRosterTurn(
      db.database,
      inbound(GRAN, "I'm your aunt", 'in-aunt'),
      ports,
    );
    expect(turn).toMatchObject({ handled: true, outcome: 'role_confirmed' });
    expect(await memberStatus(GRAN)).toBe('confirmed');
    expect(voice.calls[0]?.input).toMatchObject({
      kind: 'role_confirmed',
      facts: { roleWord: 'aunt' },
    });
    expect(
      (
        await db.database.select({ role: schema.familyMembers.role }).from(schema.familyMembers)
      ).map((row) => row.role),
    ).toEqual(expect.arrayContaining(['extended']));
  });

  it('records "not family" and seats nothing', async () => {
    await askedFamily();
    const { send, sent } = wire();
    const { ports } = turnPorts(fakeGroupOnboardingComposer(), send);
    const turn = await takeRosterTurn(
      db.database,
      inbound(GRAN, 'not family, just a friend'),
      ports,
    );
    expect(turn).toMatchObject({ handled: true, outcome: 'role_declined' });
    expect(await memberStatus(GRAN)).toBe('not_family');
    expect(sent).toEqual([]);
    expect(await db.database.select().from(schema.consentRecords)).toEqual([]);
  });
});
