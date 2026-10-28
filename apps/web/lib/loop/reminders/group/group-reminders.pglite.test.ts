import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessageReceivedJob } from '~/lib/channel/inbound-route';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
} from '~/lib/channel/intake/fakes';
import type { IntakeDeps } from '~/lib/channel/intake/machine';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { GroupTurnReader } from '~/lib/channel/linq/group-turn-reader';
import { handleLinqInboundRequest } from '~/lib/channel/linq/inbound';
import type { LinqInboundText } from '~/lib/channel/linq/payload';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { PostgresRateLimiter } from '~/lib/rate-limit/postgres';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { type GroupReminderTurnPorts, takeGroupReminderTurn } from './capture';
import { fakeGroupReminderReader, fakeGroupReminderVoice } from './fake';
import { type ChannelSendJob, runGroupReminderTick } from './fire';
import type { ReminderAsk } from './policy';
import type { GroupReminderReading } from './read';
import {
  SENDING_STALE_MS,
  cancelGroupReminders,
  claimHeld,
  claimReminder,
  closeReminder,
} from './store';
import type { GroupReminderVoice } from './voice';

/**
 * VIL-448 (T26): anyone in the family group can ask Hale for their own reminder. These
 * tests drive the real rows, ledger and sends with deterministic stand-ins for the reader
 * and the voice. What the model reads and writes is judged by the eval.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET_BYTES = Buffer.alloc(32, 9);
const HALE = '+14165550100';
const PRIYA = '+14165550111';
const DAN = '+14165550131';
const RUTH = '+14165550132';
const CHAT = 'chat-family-group';
const TZ = 'America/Toronto';
// Wednesday 2026-10-28, 14:00 in Toronto.
const NOW = new Date('2026-10-28T18:00:00.000Z');
// Thursday 2026-10-29, 16:00 in Toronto.
const THURSDAY_FOUR = new Date('2026-10-29T20:00:00.000Z');

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
  vi.stubEnv('LINQ_GROUP_REMINDERS_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users, rate_limits cascade');
});

interface Household {
  familyId: string;
  priya: string;
  dan: string;
  ruth: string;
}

async function person(input: {
  familyId: string;
  phone: string;
  name: string;
  role: 'primary_parent' | 'co_parent' | 'grandparent';
  seat: 'parent' | 'co_parent' | 'other_family';
  customer: boolean;
}): Promise<string> {
  const [user] = await db.database
    .insert(schema.users)
    .values({
      externalAuthId: `sms:${phoneBlindIndex(input.phone)}`,
      name: input.name,
      timezone: TZ,
    })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId: input.familyId, userId, role: input.role });
  await db.database.insert(schema.linqGroupMembers).values({
    familyId: input.familyId,
    chatId: CHAT,
    userId,
    phoneE164Encrypted: encryptString(input.phone),
    phoneE164Hash: phoneBlindIndex(input.phone),
    role: input.seat,
    seatedAt: NOW,
  });
  // Seating a group-only member gives them a verified channel tied to a group-only
  // consent (group-members.ts); only that consent scope says they are not a customer.
  const [consent] = input.customer
    ? []
    : await db.database
        .insert(schema.consentRecords)
        .values({
          userId,
          familyId: input.familyId,
          consentType: 'sms_service_messages',
          granted: true,
          consentScope: 'linq_group_member',
          policyVersion: 'test',
          evidence: { interpretation: 'seeded' },
        })
        .returning({ id: schema.consentRecords.id });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId: input.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(input.phone),
    phoneE164Hash: phoneBlindIndex(input.phone),
    verifiedAt: NOW,
    consentRecordId: consent?.id ?? null,
  });
  return userId;
}

/** Priya signed up; Dan and her mother Ruth are in the family group only. */
async function seedHousehold(): Promise<Household> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Priya + kids', provinceOrState: 'ON', linqGroupChatId: CHAT })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const priya = await person({
    familyId,
    phone: PRIYA,
    name: 'Priya Shah',
    role: 'primary_parent',
    seat: 'parent',
    customer: true,
  });
  const dan = await person({
    familyId,
    phone: DAN,
    name: 'Dan',
    role: 'co_parent',
    seat: 'co_parent',
    customer: false,
  });
  const ruth = await person({
    familyId,
    phone: RUTH,
    name: 'Ruth',
    role: 'grandparent',
    seat: 'other_family',
    customer: false,
  });
  const [roster] = await db.database
    .insert(schema.linqGroupRosters)
    .values({ chatId: CHAT, familyId, source: 'added_to_existing', status: 'confirmed' })
    .returning({ id: schema.linqGroupRosters.id });
  const rosterId = roster?.id as string;
  await db.database.insert(schema.linqGroupRosterMembers).values([
    {
      rosterId,
      chatId: CHAT,
      phoneE164Encrypted: encryptString(PRIYA),
      phoneE164Hash: phoneBlindIndex(PRIYA),
      knownUserId: priya,
      status: 'known_parent',
    },
    {
      rosterId,
      chatId: CHAT,
      phoneE164Encrypted: encryptString(DAN),
      phoneE164Hash: phoneBlindIndex(DAN),
      userId: dan,
      status: 'confirmed',
      confirmedRole: 'co_parent',
    },
    {
      rosterId,
      chatId: CHAT,
      phoneE164Encrypted: encryptString(RUTH),
      phoneE164Hash: phoneBlindIndex(RUTH),
      userId: ruth,
      status: 'confirmed',
      confirmedRole: 'grandparent',
    },
  ]);
  return { familyId, priya, dan, ruth };
}

function inbound(sender: string, text: string, messageId: string): LinqInboundText {
  return {
    messageId,
    chatId: CHAT,
    senderHandle: sender,
    text,
    mediaCount: 0,
    receivedAt: NOW,
    otherHandles: [],
    isGroup: true,
  };
}

function ask(overrides: Partial<ReminderAsk> = {}): ReminderAsk {
  return {
    for: 'sender',
    name: null,
    what: 'grab Maya from swim',
    date: '2026-10-29',
    time: '16:00',
    inMinutes: null,
    where: 'unsaid',
    ...overrides,
  };
}

function reading(set: ReminderAsk[], cancel: string[] = []): GroupReminderReading {
  return { request: 'reminders', set, cancel, language: 'en' };
}

function turnPorts(read: GroupReminderReading | null, options: { voiceFails?: boolean } = {}) {
  const sends: Array<{ chatId: string; text: string; replyTo?: string }> = [];
  const reader = fakeGroupReminderReader(read);
  const voice = fakeGroupReminderVoice({ fail: options.voiceFails });
  const recorded: string[] = [];
  const ports: GroupReminderTurnPorts = {
    now: NOW,
    reader,
    voice,
    send: async (input) => {
      sends.push(input);
      return { providerMessageId: `out-${sends.length}` };
    },
    recordInbound: async (message, owner) => {
      const [row] = await db.database
        .insert(schema.channelMessages)
        .values({
          familyId: owner.familyId,
          parentUserId: owner.userId,
          channel: 'imessage',
          direction: 'in',
          category: 'reply',
          providerMessageId: message.messageId,
          providerChatId: message.chatId,
          status: 'delivered',
          body: message.text,
          sentAt: message.receivedAt,
        })
        .onConflictDoNothing()
        .returning({ id: schema.channelMessages.id });
      if (row) recorded.push(row.id);
      return row?.id ?? null;
    },
  };
  return { ports, sends, reader, voice, recorded };
}

function tickPorts(now: Date, options: { voiceFails?: boolean } = {}) {
  const sends: Array<{ chatId: string; text: string; replyTo?: string }> = [];
  const jobs: ChannelSendJob[] = [];
  const voice = fakeGroupReminderVoice({ fail: options.voiceFails });
  return {
    sends,
    jobs,
    voice,
    ports: {
      now,
      voice,
      send: async (input: { chatId: string; text: string; replyTo?: string }) => {
        sends.push(input);
        return { providerMessageId: `out-tick-${sends.length}` };
      },
      enqueue: async (job: ChannelSendJob) => {
        jobs.push(job);
      },
    },
  };
}

async function reminders() {
  return db.database.select().from(schema.groupReminders);
}

async function onlyReminder() {
  const [row] = await reminders();
  if (!row) throw new Error('expected one reminder');
  return row;
}

/** A tick this long after the first one finds that first claim stale. */
const AFTER_STALE = new Date(THURSDAY_FOUR.getTime() + SENDING_STALE_MS + 60_000);

async function verbs(familyId: string) {
  const rows = await db.database
    .select({ actionTaken: schema.auditLog.actionTaken })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId));
  return rows.map((row) => row.actionTaken);
}

describe('asking for a reminder in the group', () => {
  it("confirms a grandparent's reminder in the group and keeps it there, even asked privately", async () => {
    const home = await seedHousehold();
    const { ports, sends, voice, reader } = turnPorts(reading([ask({ where: 'private' })]));

    const turn = await takeGroupReminderTurn(
      db.database,
      inbound(RUTH, 'Hale, remind me privately Thursday at 4 to grab Maya from swim', 'in-ruth-1'),
      ports,
    );

    expect(turn).toEqual({ handled: true, outcome: 'group_reminder_set' });
    expect(reader.calls[0]).toMatchObject({
      sender: 'Ruth',
      people: expect.arrayContaining(['Priya', 'Dan']),
      now: { date: '2026-10-28', weekday: 'Wednesday', time: '14:00' },
    });
    expect(sends).toEqual([
      { chatId: CHAT, text: 'confirm 1 set, 0 cancelled, 0 asked', replyTo: 'in-ruth-1' },
    ]);
    const confirm = voice.calls[0];
    expect(confirm).toMatchObject({
      kind: 'confirm',
      audience: 'group',
      asker: 'Ruth',
      set: [
        {
          what: 'grab Maya from swim',
          when: 'Thursday, October 29, 2026 at 4:00 PM',
          arrives: 'here',
          privateAsked: true,
          moved: null,
        },
      ],
    });
    const [row] = await reminders();
    expect(row).toMatchObject({
      familyId: home.familyId,
      status: 'scheduled',
      delivery: 'group',
      forKind: 'sender',
      askedByUserId: home.ruth,
      askedByPhoneHash: phoneBlindIndex(RUTH),
      forPhoneHash: phoneBlindIndex(RUTH),
      deliverAt: THURSDAY_FOUR,
      sourceMessageId: 'in-ruth-1',
    });
    const [ledger] = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.templateKey, 'linq:group_reminder_confirm'));
    expect(ledger).toMatchObject({
      direction: 'out',
      providerChatId: CHAT,
      providerMessageId: 'out-1',
      parentUserId: home.priya,
    });
    expect(await verbs(home.familyId)).toEqual(
      expect.arrayContaining(['group_reminder_set', 'sms_reply_sent']),
    );
  });

  it("hands a signed-up parent's own reminder to the 1:1 dispatch, and names it queued, not sent", async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const home = await seedHousehold();
    const { ports, voice } = turnPorts(reading([ask()]));

    const turn = await takeGroupReminderTurn(
      db.database,
      inbound(PRIYA, 'remind me thursday at 4 to grab Maya', 'in-priya-1'),
      ports,
    );

    expect(turn).toMatchObject({ outcome: 'group_reminder_set' });
    expect(voice.calls[0]).toMatchObject({ set: [{ arrives: 'private_text' }] });
    const [row] = await reminders();
    expect(row).toMatchObject({ delivery: 'direct', askedByUserId: home.priya });

    const tick = tickPorts(THURSDAY_FOUR);
    expect(await runGroupReminderTick(db.database, tick.ports)).toEqual({
      due: 1,
      sent: 0,
      queued: 1,
      dropped: 0,
      failed: 0,
      lost: 0,
      retrying: 0,
    });
    expect(tick.sends).toEqual([]);
    expect(await onlyReminder()).toMatchObject({ status: 'queued', what: null });
    const actions = await verbs(home.familyId);
    expect(actions).toContain('group_reminder_queued');
    expect(actions).not.toContain('group_reminder_sent');
    expect(tick.jobs).toEqual([
      {
        templateKey: 'member_reminder',
        familyId: home.familyId,
        parentUserId: home.priya,
        category: 'reminder',
        urgency: 'normal',
        payload: { text: 'reminder for Priya' },
        dedupeKey: `group-reminder:${row?.id}`,
        channel: 'sms',
      },
    ]);
    expect(tick.voice.calls[0]).toMatchObject({ kind: 'reminder', audience: 'direct' });
  });

  it('keeps that same parent in the group while the loop cannot send 1:1', async () => {
    await seedHousehold();
    const { ports, voice } = turnPorts(reading([ask()]));
    await takeGroupReminderTurn(db.database, inbound(PRIYA, 'remind me at 4', 'in-p'), ports);
    expect(voice.calls[0]).toMatchObject({ set: [{ arrives: 'here' }] });
    expect((await reminders())[0]?.delivery).toBe('group');
  });

  it('reminds Dan in the group when someone else asks for him', async () => {
    const home = await seedHousehold();
    const { ports } = turnPorts(
      reading([ask({ for: 'person', name: 'Dan', what: 'call the coach' })]),
    );

    await takeGroupReminderTurn(
      db.database,
      inbound(PRIYA, 'remind Dan at 4 to call the coach', 'in-d'),
      ports,
    );

    const [row] = await reminders();
    expect(row).toMatchObject({
      forKind: 'person',
      forUserId: home.dan,
      forPhoneHash: phoneBlindIndex(DAN),
      forName: 'Dan',
      delivery: 'group',
    });

    const tick = tickPorts(THURSDAY_FOUR);
    await runGroupReminderTick(db.database, tick.ports);
    expect(tick.sends).toEqual([{ chatId: CHAT, text: 'reminder for Dan', replyTo: 'in-d' }]);
    expect(tick.voice.calls[0]).toMatchObject({
      kind: 'reminder',
      audience: 'group',
      forName: 'Dan',
      askedByName: 'Priya',
    });
    const [sent] = await reminders();
    expect(sent).toMatchObject({ status: 'sent', what: null });
    expect(await verbs(home.familyId)).toContain('group_reminder_sent');
  });

  it('moves a reminder out of quiet hours and tells the voice why', async () => {
    await seedHousehold();
    const { ports, voice } = turnPorts(reading([ask({ time: '21:30' })]));
    await takeGroupReminderTurn(
      db.database,
      inbound(RUTH, 'remind me at 9:30 tomorrow night', 'in-q'),
      ports,
    );
    expect(voice.calls[0]).toMatchObject({
      set: [
        {
          moved: 'earlier',
          when: 'Thursday, October 29, 2026 at 8:45 PM',
          askedFor: 'Thursday, October 29, 2026 at 9:30 PM',
        },
      ],
    });
  });

  it('asks when, and sets nothing, when no time was given', async () => {
    await seedHousehold();
    const { ports, voice, sends } = turnPorts(reading([ask({ date: null, time: null })]));
    const turn = await takeGroupReminderTurn(
      db.database,
      inbound(RUTH, 'Hale can you remind me to grab Maya', 'in-w'),
      ports,
    );
    expect(turn).toEqual({ handled: true, outcome: 'group_reminder_asked_when' });
    expect(voice.calls[0]).toMatchObject({ set: [], needsTime: [{ what: 'grab Maya from swim' }] });
    expect(sends).toHaveLength(1);
    expect(await reminders()).toEqual([]);
  });

  it('cancels a reminder the asker set, by the ref the reader was shown', async () => {
    const home = await seedHousehold();
    await takeGroupReminderTurn(
      db.database,
      inbound(RUTH, 'remind me at 4', 'in-1'),
      turnPorts(reading([ask()])).ports,
    );
    const second = turnPorts(reading([], ['r1']));

    const turn = await takeGroupReminderTurn(
      db.database,
      inbound(RUTH, 'actually never mind', 'in-2'),
      second.ports,
    );

    expect(turn).toEqual({ handled: true, outcome: 'group_reminder_cancelled' });
    expect(second.reader.calls[0]?.open).toEqual([
      {
        ref: 'r1',
        for: 'sender',
        what: 'grab Maya from swim',
        when: 'Thursday, October 29, 2026 at 4:00 PM',
      },
    ]);
    expect(second.voice.calls[0]).toMatchObject({ cancelled: [{ what: 'grab Maya from swim' }] });
    const [row] = await reminders();
    expect(row).toMatchObject({ status: 'cancelled', statusReason: 'asked', what: null });
    expect(await verbs(home.familyId)).toContain('group_reminder_cancelled');
  });

  it('sends nothing and sets nothing when the confirmation cannot be written', async () => {
    const home = await seedHousehold();
    const { ports, sends } = turnPorts(reading([ask()]), { voiceFails: true });

    const turn = await takeGroupReminderTurn(
      db.database,
      inbound(RUTH, 'remind me at 4', 'in-x'),
      ports,
    );

    expect(turn).toEqual({ handled: true, outcome: 'group_reminder_unwritten' });
    expect(sends).toEqual([]);
    const [row] = await reminders();
    expect(row).toMatchObject({ status: 'cancelled', statusReason: 'confirm_unwritten' });
    expect(await verbs(home.familyId)).toContain('group_reminder_unwritten');
    expect(await runGroupReminderTick(db.database, tickPorts(THURSDAY_FOUR).ports)).toMatchObject({
      due: 0,
    });
  });

  it('leaves anything that is not a reminder ask to the coach, untouched', async () => {
    await seedHousehold();
    const other = turnPorts({ request: 'other', set: [], cancel: [], language: 'en' });
    expect(
      await takeGroupReminderTurn(
        db.database,
        inbound(RUTH, 'what time is swim?', 'in-o'),
        other.ports,
      ),
    ).toEqual({ handled: false, reason: 'not_reminders' });
    const failed = turnPorts(null);
    expect(
      await takeGroupReminderTurn(
        db.database,
        inbound(RUTH, 'remind me at 4', 'in-f'),
        failed.ports,
      ),
    ).toEqual({ handled: false, reason: 'unread' });
    expect(other.recorded).toEqual([]);
    expect(failed.sends).toEqual([]);
    expect(await reminders()).toEqual([]);
  });

  it('answers a replayed webhook once', async () => {
    await seedHousehold();
    const first = turnPorts(reading([ask()]));
    await takeGroupReminderTurn(db.database, inbound(RUTH, 'remind me at 4', 'in-r'), first.ports);
    const again = turnPorts(reading([ask()]));
    expect(
      await takeGroupReminderTurn(
        db.database,
        inbound(RUTH, 'remind me at 4', 'in-r'),
        again.ports,
      ),
    ).toEqual({ handled: false, reason: 'replay' });
    expect(again.sends).toEqual([]);
    expect(await reminders()).toHaveLength(1);
  });
});

describe('when a group reminder is due', () => {
  async function setFor(sender: string, overrides: Partial<ReminderAsk> = {}) {
    await takeGroupReminderTurn(
      db.database,
      inbound(sender, 'remind me', `in-${sender}`),
      turnPorts(reading([ask(overrides)])).ports,
    );
  }

  it('posts it in the group, names the person, and closes the row', async () => {
    await seedHousehold();
    await setFor(RUTH);
    const tick = tickPorts(new Date(THURSDAY_FOUR.getTime() + 30_000));

    expect(await runGroupReminderTick(db.database, tick.ports)).toEqual({
      due: 1,
      sent: 1,
      queued: 0,
      dropped: 0,
      failed: 0,
      lost: 0,
      retrying: 0,
    });
    expect(tick.sends).toEqual([
      { chatId: CHAT, text: 'reminder for Ruth', replyTo: `in-${RUTH}` },
    ]);
    expect(tick.voice.calls[0]).toMatchObject({
      forName: 'Ruth',
      askedByName: null,
      what: 'grab Maya from swim',
    });
    expect(await runGroupReminderTick(db.database, tick.ports)).toMatchObject({ due: 0 });
    expect(tick.sends).toHaveLength(1);
  });

  it('speaks to a grandparent Hale has no name for as the person who asked, not to everyone', async () => {
    const home = await seedHousehold();
    await db.database
      .update(schema.users)
      .set({ name: null })
      .where(eq(schema.users.id, home.ruth));
    await setFor(RUTH);
    const tick = tickPorts(THURSDAY_FOUR);

    await runGroupReminderTick(db.database, tick.ports);

    expect(tick.voice.calls[0]).toMatchObject({ forName: null, forEveryone: false, asker: null });
    expect(tick.sends).toEqual([
      { chatId: CHAT, text: 'reminder for the asker', replyTo: `in-${RUTH}` },
    ]);
  });

  it('does not fire before its time', async () => {
    await seedHousehold();
    await setFor(RUTH);
    const tick = tickPorts(new Date(THURSDAY_FOUR.getTime() - 60_000));
    expect(await runGroupReminderTick(db.database, tick.ports)).toMatchObject({ due: 0 });
  });

  it('cancels a member’s reminders when they STOP, so nothing fires', async () => {
    const home = await seedHousehold();
    await setFor(RUTH);
    await setFor(DAN);

    await cancelGroupReminders(db.database, {
      chatId: CHAT,
      phoneHash: phoneBlindIndex(RUTH),
      reason: 'member_stop',
      now: NOW,
    });

    const rows = await reminders();
    expect(rows.find((row) => row.askedByUserId === home.ruth)).toMatchObject({
      status: 'cancelled',
      statusReason: 'member_stop',
    });
    expect(rows.find((row) => row.askedByUserId === home.dan)?.status).toBe('scheduled');
    const tick = tickPorts(THURSDAY_FOUR);
    await runGroupReminderTick(db.database, tick.ports);
    expect(tick.sends).toEqual([{ chatId: CHAT, text: 'reminder for Dan', replyTo: `in-${DAN}` }]);
  });

  it('lets a STOP that lands while the reminder is being written win, and sends nothing', async () => {
    const home = await seedHousehold();
    await setFor(RUTH);
    const tick = tickPorts(THURSDAY_FOUR);
    const stoppedMidWrite: GroupReminderVoice = {
      async write(facts) {
        await cancelGroupReminders(db.database, {
          chatId: CHAT,
          phoneHash: phoneBlindIndex(RUTH),
          reason: 'member_stop',
          now: THURSDAY_FOUR,
        });
        return tick.voice.write(facts);
      },
    };

    expect(
      await runGroupReminderTick(db.database, { ...tick.ports, voice: stoppedMidWrite }),
    ).toMatchObject({ due: 1, sent: 0, lost: 1 });
    expect(tick.sends).toEqual([]);
    expect(await onlyReminder()).toMatchObject({
      status: 'cancelled',
      statusReason: 'member_stop',
      what: null,
    });
    const actions = await verbs(home.familyId);
    expect(actions).toContain('group_reminder_cancelled');
    expect(actions).not.toContain('group_reminder_sent');
  });

  it('audits only a close that happened: a stale tick cannot close the newer claim', async () => {
    const home = await seedHousehold();
    await setFor(RUTH);
    const { id } = await onlyReminder();
    const stale = await claimReminder(db.database, id, THURSDAY_FOUR);
    const fresh = await claimReminder(db.database, id, AFTER_STALE);
    if (!stale || !fresh) throw new Error('expected both claims');

    expect(await claimHeld(db.database, stale)).toBe(false);
    expect(
      await closeReminder(db.database, stale, { status: 'sent', reason: null, now: AFTER_STALE }),
    ).toBe(false);
    expect(await onlyReminder()).toMatchObject({ status: 'sending', what: 'grab Maya from swim' });
    expect(await verbs(home.familyId)).not.toContain('group_reminder_sent');

    expect(
      await closeReminder(db.database, fresh, { status: 'sent', reason: null, now: AFTER_STALE }),
    ).toBe(true);
    expect(await verbs(home.familyId)).toContain('group_reminder_sent');
  });

  it('leaves a reminder whose handoff hit an error to a later tick, words intact, and sends it once', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const home = await seedHousehold();
    await setFor(PRIYA);
    const { id, delivery } = await onlyReminder();
    expect(delivery).toBe('direct');

    const down = tickPorts(THURSDAY_FOUR);
    const queueDown = {
      ...down.ports,
      enqueue: async () => {
        throw new Error('queue unreachable');
      },
    };
    expect(await runGroupReminderTick(db.database, queueDown)).toMatchObject({
      due: 1,
      retrying: 1,
      failed: 0,
    });
    expect(await onlyReminder()).toMatchObject({ status: 'sending', what: 'grab Maya from swim' });
    const nextMinute = new Date(THURSDAY_FOUR.getTime() + 60_000);
    expect(await runGroupReminderTick(db.database, tickPorts(nextMinute).ports)).toMatchObject({
      due: 0,
    });

    const back = tickPorts(AFTER_STALE);
    expect(await runGroupReminderTick(db.database, back.ports)).toMatchObject({
      due: 1,
      queued: 1,
    });
    expect(back.jobs.map((job) => job.dedupeKey)).toEqual([`group-reminder:${id}`]);
    expect(await onlyReminder()).toMatchObject({ status: 'queued', what: null });
    expect(await verbs(home.familyId)).not.toContain('group_reminder_failed');
  });

  it('tries a group line again after a temporary Linq refusal, and posts it once', async () => {
    await seedHousehold();
    await setFor(RUTH);
    const busy = {
      ...tickPorts(THURSDAY_FOUR).ports,
      send: async () => {
        throw new LinqSendError('503', 503, false);
      },
    };
    expect(await runGroupReminderTick(db.database, busy)).toMatchObject({ retrying: 1 });
    expect((await onlyReminder()).status).toBe('sending');

    const back = tickPorts(AFTER_STALE);
    expect(await runGroupReminderTick(db.database, back.ports)).toMatchObject({ sent: 1 });
    expect(back.sends).toEqual([
      { chatId: CHAT, text: 'reminder for Ruth', replyTo: `in-${RUTH}` },
    ]);
  });

  it('never tries again after a timeout, which may have landed', async () => {
    await seedHousehold();
    await setFor(RUTH);
    const timedOut = {
      ...tickPorts(THURSDAY_FOUR).ports,
      send: async () => {
        throw new LinqSendError('timeout', 0, false);
      },
    };
    expect(await runGroupReminderTick(db.database, timedOut)).toMatchObject({ failed: 1 });
    expect(await onlyReminder()).toMatchObject({ status: 'failed', statusReason: 'timeout' });
  });

  it('drops one whose asker left the chat before it fired, by name', async () => {
    await seedHousehold();
    await setFor(RUTH);
    await db.database
      .update(schema.linqGroupMembers)
      .set({ removedAt: NOW })
      .where(eq(schema.linqGroupMembers.phoneE164Hash, phoneBlindIndex(RUTH)));

    const tick = tickPorts(THURSDAY_FOUR);
    expect(await runGroupReminderTick(db.database, tick.ports)).toMatchObject({ dropped: 1 });
    expect(tick.sends).toEqual([]);
    expect((await reminders())[0]).toMatchObject({ status: 'dropped', statusReason: 'asker_gone' });
  });

  it('drops a 1:1 reminder whose asker is no longer a customer, and never posts it in the group', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    const home = await seedHousehold();
    const [own] = await db.database
      .insert(schema.consentRecords)
      .values({
        userId: home.dan,
        familyId: home.familyId,
        consentType: 'sms_service_messages',
        granted: true,
        consentScope: 'sms_coparent_invite_reply',
        policyVersion: 'test',
        evidence: { interpretation: 'seeded' },
      })
      .returning({ id: schema.consentRecords.id });
    await setFor(DAN);
    expect((await onlyReminder()).delivery).toBe('direct');

    await db.database
      .delete(schema.consentRecords)
      .where(eq(schema.consentRecords.id, own?.id as string));
    const tick = tickPorts(THURSDAY_FOUR);

    expect(await runGroupReminderTick(db.database, tick.ports)).toMatchObject({
      due: 1,
      dropped: 1,
      queued: 0,
    });
    expect(tick.jobs).toEqual([]);
    expect(tick.sends).toEqual([]);
    expect(tick.voice.calls).toEqual([]);
    expect(await onlyReminder()).toMatchObject({
      status: 'dropped',
      statusReason: 'asker_not_customer',
      what: null,
    });
  });

  it('drops one that comes due inside quiet hours rather than waking the group', async () => {
    await seedHousehold();
    await setFor(RUTH);
    await db.database
      .update(schema.groupReminders)
      .set({ deliverAt: new Date('2026-10-30T02:00:00.000Z') });
    const tick = tickPorts(new Date('2026-10-30T02:00:30.000Z'));
    expect(await runGroupReminderTick(db.database, tick.ports)).toMatchObject({ dropped: 1 });
    expect((await reminders())[0]?.statusReason).toBe('quiet_hours');
  });

  it('sends nothing when the reminder cannot be written', async () => {
    const home = await seedHousehold();
    await setFor(RUTH);
    const tick = tickPorts(THURSDAY_FOUR, { voiceFails: true });
    expect(await runGroupReminderTick(db.database, tick.ports)).toMatchObject({ failed: 1 });
    expect(tick.sends).toEqual([]);
    expect((await reminders())[0]).toMatchObject({ status: 'failed', statusReason: 'unwritten' });
    expect(await verbs(home.familyId)).toContain('group_reminder_failed');
  });

  it('names a tick with no voice rather than claiming anything', async () => {
    await seedHousehold();
    await setFor(RUTH);
    expect(
      await runGroupReminderTick(db.database, { ...tickPorts(THURSDAY_FOUR).ports, voice: null }),
    ).toEqual({ skipped: 'voice_unavailable' });
    expect((await reminders())[0]?.status).toBe('scheduled');
  });
});

describe('the Linq door', () => {
  const TS = String(Math.floor(NOW.getTime() / 1000));

  function signed(body: unknown): Request {
    const raw = JSON.stringify(body);
    const mac = createHmac('sha256', SECRET_BYTES).update(`evt_rem.${TS}.${raw}`).digest('base64');
    return new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'evt_rem',
        'webhook-timestamp': TS,
        'webhook-signature': `v1,${mac}`,
      },
      body: raw,
    });
  }

  function groupMessage(sender: string, text: string, messageId: string) {
    return {
      api_version: 'v3',
      webhook_version: '2026-02-03',
      event_type: 'message.received',
      event_id: 'evt_rem',
      created_at: NOW.toISOString(),
      data: {
        chat: { id: CHAT, is_group: true },
        id: messageId,
        direction: 'inbound',
        sender_handle: { handle: sender, is_me: false },
        parts: [{ type: 'text', value: text }],
        sent_at: NOW.toISOString(),
        service: 'iMessage',
      },
    };
  }

  function door(read: GroupReminderReading) {
    const jobs: ChannelMessageReceivedJob[] = [];
    const outcomes: string[] = [];
    const sends: Array<{ chatId: string; text: string; replyTo?: string }> = [];
    const addressed: GroupTurnReader = { read: async () => 'addressed' };
    const intake: IntakeDeps = {
      transport: new FakeTransport(),
      threadMessage: async () => 'conv-1',
      extractor: new FakeExtractor([{ children: [], postalCode: null }]),
      intentReader: new FakeIntentReader([
        { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
      ]),
      radar: fakeRadar,
      answerComposer: fakeSilentAnswerComposer,
      openQuestions: fakeNoOpenQuestions,
      identityAsk: new FakeIdentityAsk(),
      limiter: new PostgresRateLimiter(db.database),
      now: NOW,
    };
    const deps = {
      database: db.database,
      intake: () => intake,
      enqueue: async (job: ChannelMessageReceivedJob) => {
        jobs.push(job);
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      countOutcome: async (outcome: string) => {
        outcomes.push(outcome);
      },
      now: () => NOW,
      groupLimiter: new PostgresRateLimiter(db.database),
      groupTurnReader: addressed,
      groupReminderReader: fakeGroupReminderReader(read),
      groupReminderVoice: fakeGroupReminderVoice(),
      sendGroupText: async (input: { chatId: string; text: string; replyTo?: string }) => {
        sends.push(input);
        return { providerMessageId: `out-${sends.length}` };
      },
    } as unknown as Parameters<typeof handleLinqInboundRequest>[1];
    return { deps, jobs, outcomes, sends };
  }

  beforeEach(() => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_WEBHOOK_SECRET', `whsec_${SECRET_BYTES.toString('base64')}`);
  });

  it("answers a grandparent's reminder ask in the group and does not hand it to the coach", async () => {
    const home = await seedHousehold();
    const { deps, jobs, outcomes, sends } = door(reading([ask()]));

    const response = await handleLinqInboundRequest(
      signed(groupMessage(RUTH, 'Hale, remind me Thursday at 4 to grab Maya from swim', 'in-door')),
      deps,
    );

    expect(await response.json()).toEqual({ outcome: 'group_reminder_set' });
    expect(outcomes).toEqual(['intake']);
    expect(jobs).toEqual([]);
    expect(sends).toEqual([
      { chatId: CHAT, text: 'confirm 1 set, 0 cancelled, 0 asked', replyTo: 'in-door' },
    ]);
    const [inboundRow] = await db.database
      .select()
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.providerMessageId, 'in-door'),
          eq(schema.channelMessages.direction, 'in'),
        ),
      );
    expect(inboundRow).toMatchObject({ familyId: home.familyId, parentUserId: home.ruth });
    expect((await reminders())[0]).toMatchObject({ status: 'scheduled', delivery: 'group' });
  });

  it('hands anything else to the coach exactly as before', async () => {
    await seedHousehold();
    const { deps, jobs, sends } = door({ request: 'other', set: [], cancel: [], language: 'en' });

    const response = await handleLinqInboundRequest(
      signed(groupMessage(PRIYA, 'Hale what time is swim?', 'in-coach')),
      deps,
    );

    expect(await response.json()).toEqual({ outcome: 'handed_off' });
    expect(sends).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(await reminders()).toEqual([]);
  });

  it('stays out of the way with the flag off', async () => {
    vi.stubEnv('LINQ_GROUP_REMINDERS_ENABLED', '');
    await seedHousehold();
    const { deps, jobs } = door(reading([ask()]));

    const response = await handleLinqInboundRequest(
      signed(groupMessage(PRIYA, 'Hale remind me at 4', 'in-off')),
      deps,
    );

    expect(await response.json()).toEqual({ outcome: 'handed_off' });
    expect(jobs).toHaveLength(1);
    expect(await reminders()).toEqual([]);
  });
});
