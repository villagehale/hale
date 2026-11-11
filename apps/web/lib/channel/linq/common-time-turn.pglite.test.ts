import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { departCoParent } from '~/lib/channel/coparent/depart';
import type { SpokenLineRequest } from '~/lib/channel/spoken-line';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { freeBusyScope } from './free-busy-consent';
import { takeMultiFamilyTurn, unseatMultiFamilyMember } from './multi-family';
import type { ListChatHandles } from './roster';
import type { SharedGroupReader, SharedGroupReading } from './shared-group-reading';
import { fakeSharedGroupComposer } from './shared-group-voice-fake';

// VIL-459 — "when can we all do it?" in a group several families share.

const KEY = Buffer.alloc(32, 7).toString('base64');
const FROM = '+16462352164';
// Wed Oct 28 2026, 11:00 in New York.
const NOW = new Date('2026-10-28T15:00:00.000Z');
const CHAT = 'chat-common-time';
const ZONE = 'America/New_York';
const PRIVATE_TITLE = 'zephyr-private-title';

const MEI = '+16415550101';
const ADA = '+16415550201';
const BO = '+16415550202';
const PRIYA = '+16415550301';
// In the chat, but no family Hale knows.
const GUEST = '+16415550401';
// The account name never reaches the group or the writer; only a name the group uses does.
const ACCOUNT = 'Accountname';
const ASK = 'Hale, when can all three families do the zoo? Friday is out for us';

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
  vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_COMMON_TIME_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table linq_shared_group_people, linq_multi_family_joins, linq_multi_family_members, linq_multi_family_ledger, families, users cascade',
  );
});

function sender() {
  const texts: string[] = [];
  const send = async (notice: { chatId: string; text: string }) => {
    texts.push(notice.text);
    return { providerMessageId: `msg-${texts.length}` };
  };
  return { send, texts };
}

const listOf =
  (handles: readonly string[]): ListChatHandles =>
  async () => ({ status: 'ok', handles: [...handles], isGroup: true });

function findTime(ruledOut: SharedGroupReading['ruledOut'] = []) {
  const seen: Parameters<SharedGroupReader['read']>[0][] = [];
  const reader: SharedGroupReader = {
    async read(input) {
      seen.push(input);
      return {
        intent: 'find_time',
        role: 'unclear',
        familyLabel: null,
        kidName: null,
        confidence: 'high',
        ruledOut,
      };
    },
  };
  return { reader, seen };
}

function saying(intent: SharedGroupReading['intent']): SharedGroupReader {
  return {
    async read() {
      return { intent, role: 'unclear', familyLabel: null, kidName: null, confidence: 'high' };
    },
  };
}

const minutesLater = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

/** Each parent's latest free/busy row in this chat: true means it still stands. */
async function freeBusyLedger(userId: string): Promise<boolean[]> {
  const rows = await db.database
    .select({ granted: schema.consentRecords.granted })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.userId, userId),
        eq(schema.consentRecords.consentScope, freeBusyScope(CHAT)),
      ),
    )
    .orderBy(schema.consentRecords.grantedAt);
  return rows.map((row) => row.granted);
}

function writer(text: string | null = 'written by the model') {
  const calls: SpokenLineRequest[] = [];
  const write = async (request: SpokenLineRequest) => {
    calls.push(request);
    return text;
  };
  return { write, calls };
}

async function seedParent(
  phone: string,
  name: string,
  timezone: string,
  coParentOf?: { familyId: string },
) {
  const familyId =
    coParentOf?.familyId ??
    ((
      await db.database
        .insert(schema.families)
        .values({ displayName: name, provinceOrState: 'NY' })
        .returning({ id: schema.families.id })
    )[0]?.id as string);
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}-${phone}`, name: `${name}${ACCOUNT}`, timezone })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId, role: coParentOf ? 'co_parent' : 'primary_parent' });
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

async function connectCalendar(
  parent: { familyId: string; userId: string },
  busy: readonly { start: string; end: string; title?: string; eventId?: string }[],
) {
  const [existing] = await db.database
    .select({ id: schema.integrations.id })
    .from(schema.integrations)
    .where(eq(schema.integrations.userId, parent.userId));
  const [integration] = existing
    ? [existing]
    : await db.database
        .insert(schema.integrations)
        .values({
          familyId: parent.familyId,
          userId: parent.userId,
          provider: 'gcal',
          status: 'active',
        })
        .returning({ id: schema.integrations.id });
  for (const [index, span] of busy.entries()) {
    await db.database.insert(schema.parentCalendarBlocks).values({
      integrationId: integration?.id as string,
      eventId: span.eventId ?? `event-${parent.userId}-${index}`,
      familyId: parent.familyId,
      userId: parent.userId,
      startAt: new Date(span.start),
      endAt: new Date(span.end),
      kidRelated: Boolean(span.title),
      title: span.title ?? null,
      status: 'confirmed',
      updatedStamp: 'stamp',
    });
  }
}

async function threeFamilies() {
  const mei = await seedParent(MEI, 'Mei', ZONE);
  const ada = await seedParent(ADA, 'Ada', ZONE);
  // Never set (UTC is "unset"): read on the asking family's clock, never a city default.
  const priya = await seedParent(PRIYA, 'Priya', 'UTC');
  // Mei: all of Wednesday, with a private kid event title on the row.
  await connectCalendar(mei, [
    { start: '2026-10-28T12:00:00Z', end: '2026-10-29T02:00:00Z', title: PRIVATE_TITLE },
  ]);
  // Ada: Thursday 08:00 to 19:00 New York.
  await connectCalendar(ada, [{ start: '2026-10-29T12:00:00Z', end: '2026-10-29T23:00:00Z' }]);
  return { mei, ada, priya };
}

async function turn(
  ports: {
    reader: SharedGroupReader;
    write: (request: SpokenLineRequest) => Promise<string | null>;
  },
  wire: ReturnType<typeof sender>,
  id = 'in-1',
  from = MEI,
  at = NOW,
) {
  return takeMultiFamilyTurn(
    db.database,
    {
      chatId: CHAT,
      senderHandle: from,
      text: ASK,
      providerMessageId: id,
      receivedAt: at,
      now: at,
      send: wire.send,
    },
    {
      listHandles: listOf([MEI, ADA, BO, PRIYA, GUEST]),
      reader: ports.reader,
      composer: fakeSharedGroupComposer(),
      commonTimeWriter: ports.write,
    },
  );
}

// Friday Oct 30, all day in New York.
const FRIDAY = { start: new Date('2026-10-30T04:00:00Z'), end: new Date('2026-10-31T04:00:00Z') };

async function proposedSlots(): Promise<string[][]> {
  const rows = await db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.actionTaken, 'linq_multi_family_common_time_proposed'))
    .orderBy(schema.auditLog.occurredAt);
  return rows.map((row) => (row.after as { slots: string[] }).slots);
}

async function nameInGroup(phone: string, firstName: string) {
  await db.database
    .update(schema.linqSharedGroupPeople)
    .set({ firstName })
    .where(eq(schema.linqSharedGroupPeople.phoneE164Hash, phoneBlindIndex(phone)));
}

describe('common time in a shared group', () => {
  it('proposes times that avoid every calendar its parent shared and what the chat ruled out, and asks the family Hale cannot see', async () => {
    await threeFamilies();
    const { reader, seen } = findTime([FRIDAY]);
    // Ada's own ask is her say-so for her calendar; Mei's ask is hers.
    await turn({ reader, write: writer().write }, sender(), 'in-0', ADA);
    await nameInGroup(MEI, 'Mei');
    const { write, calls } = writer();
    const wire = sender();

    const out = await turn({ reader, write }, wire);

    expect(out).toMatchObject({ handled: true, outcome: 'common_time_proposed', count: 'intake' });
    expect(wire.texts).toEqual(['written by the model']);
    expect(seen[1]?.clock).toEqual({ now: NOW.toISOString(), timeZone: ZONE });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.purpose).toBe('group_common_time');
    // A name the group uses, else a neutral label: never the account name.
    expect(calls[0]?.facts?.checkedFamilies).toBe('Mei, family 2');
    expect(calls[0]?.facts?.askFamilies).toBe('family 3');
    expect(calls[0]?.facts?.proposalCount).toBe('3');
    expect(JSON.stringify(calls)).not.toContain(PRIVATE_TITLE);
    expect(JSON.stringify(calls)).not.toContain(ACCOUNT);

    const [, slots] = await proposedSlots();
    // Not Wednesday (Mei), not Thursday before 19:00 (Ada), not Friday (the chat), and
    // inside 08:00 to 21:00 New York for every family, Priya included.
    expect(slots).toEqual([
      '2026-10-29T23:00:00.000Z',
      '2026-10-31T12:00:00.000Z',
      '2026-11-01T13:00:00.000Z',
    ]);
  });

  it('a known parent linked by number who has said nothing is not read: that family is asked', async () => {
    await threeFamilies();
    const { reader } = findTime();
    const { write, calls } = writer();

    await turn({ reader, write }, sender());

    expect(calls[0]?.facts?.checkedFamilies).toBe('family 1');
    expect(calls[0]?.facts?.askFamilies).toBe('family 2, family 3');
    // Thursday 08:00 New York is free: Ada's busy Thursday was never read.
    const [slots] = await proposedSlots();
    expect(slots?.[0]).toBe('2026-10-29T12:00:00.000Z');
  });

  it('a family that has not shared does not shape the times with its zone or quiet hours', async () => {
    const { priya } = await threeFamilies();
    await db.database
      .update(schema.users)
      .set({ timezone: 'America/Los_Angeles' })
      .where(eq(schema.users.id, priya.userId));
    await db.database
      .insert(schema.loopPrefs)
      .values({ userId: priya.userId, quietHoursStart: '21:00:00', quietHoursEnd: '10:00:00' });
    const { reader } = findTime();

    const before = writer();
    await turn({ reader, write: before.write }, sender(), 'in-1');
    // Priya's own ask shares her family's clock; Mei asks again.
    await turn({ reader, write: writer().write }, sender(), 'in-2', PRIYA);
    const after = writer();
    await turn({ reader, write: after.write }, sender(), 'in-3');

    const [unshared, , shared] = await proposedSlots();
    expect(unshared?.[0]).toBe('2026-10-29T12:00:00.000Z');
    expect(before.calls[0]?.facts?.option1).not.toContain('America/Los_Angeles');
    // Positive control: once shared, 10:00 Los Angeles is the earliest Thursday start.
    expect(shared?.[0]).toBe('2026-10-29T17:00:00.000Z');
    expect(after.calls[0]?.facts?.option1).toContain('America/Los_Angeles');
  });

  it("reads a co-parent's calendar only on that co-parent's own say-so", async () => {
    const { ada } = await threeFamilies();
    const bo = await seedParent(BO, 'Bo', ZONE, ada);
    // Bo: Saturday 08:00 to 20:00 New York.
    await connectCalendar(bo, [{ start: '2026-10-31T12:00:00Z', end: '2026-11-01T00:00:00Z' }]);
    // A private (sensitive) plan's calendar copy on Ada's calendar: Sunday all day.
    await connectCalendar(ada, [
      { start: '2026-11-01T12:00:00Z', end: '2026-11-02T03:00:00Z', eventId: 'private-copy' },
    ]);
    await db.database.insert(schema.familyEvents).values({
      familyId: ada.familyId,
      title: 'private plan',
      startsAt: new Date('2026-11-01T12:00:00Z'),
      source: 'placement',
      sensitive: true,
      placedGoogleEventId: 'private-copy',
    });
    const { reader } = findTime([FRIDAY]);

    await turn({ reader, write: writer().write }, sender(), 'in-0', ADA);
    await turn({ reader, write: writer().write }, sender(), 'in-1');
    await turn({ reader, write: writer().write }, sender(), 'in-2', BO);
    await turn({ reader, write: writer().write }, sender(), 'in-3');

    const [, withoutBo, , withBo] = await proposedSlots();
    // Ada's own busy Thursday is used (positive control); Bo's Saturday is not yet; the
    // private copy's Sunday never is.
    // Sunday Nov 1 is on standard time: 08:00 New York is 13:00Z.
    expect(withoutBo).toEqual([
      '2026-10-29T23:00:00.000Z',
      '2026-10-31T12:00:00.000Z',
      '2026-11-01T13:00:00.000Z',
    ]);
    // Bo's Saturday pushes that day's time to 20:00 New York.
    expect(withBo).toEqual([
      '2026-10-29T23:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
      '2026-11-01T13:00:00.000Z',
    ]);
  });

  it('reads no calendar once a family has left this chat: that family is asked', async () => {
    const { ada } = await threeFamilies();
    const { reader } = findTime();
    await turn({ reader, write: writer().write }, sender(), 'in-0', ADA);
    const first = writer();
    await turn({ reader, write: first.write }, sender(), 'in-1');
    const [linked] = await db.database
      .select({ consentRecordId: schema.linqMultiFamilyJoins.consentRecordId })
      .from(schema.linqMultiFamilyJoins)
      .where(eq(schema.linqMultiFamilyJoins.familyId, ada.familyId));
    await db.database
      .update(schema.consentRecords)
      .set({ revokedAt: NOW })
      .where(eq(schema.consentRecords.id, linked?.consentRecordId as string));

    const { write, calls } = writer();
    await turn({ reader, write }, sender(), 'in-2');

    expect(first.calls[0]?.facts?.checkedFamilies).toBe('family 1, family 2');
    expect(calls[0]?.facts?.checkedFamilies).toBe('family 1');
    expect(calls[0]?.facts?.askFamilies).toBe('family 2, family 3');
  });

  it("leaving ends a parent's say-so: after a re-join, their busy time is read only on a fresh ask", async () => {
    const { ada } = await threeFamilies();
    const { reader } = findTime();
    await turn({ reader, write: writer().write }, sender(), 'in-0', ADA);
    await nameInGroup(ADA, 'Ada');
    const shared = writer();
    await turn({ reader, write: shared.write }, sender(), 'in-1');

    await turn(
      { reader: saying('leave'), write: writer().write },
      sender(),
      'in-2',
      ADA,
      minutesLater(1),
    );
    // Mei's next turn does not join Ada's family back: only Ada's own words can.
    const rejoined = writer();
    await turn({ reader, write: rejoined.write }, sender(), 'in-3', MEI, minutesLater(2));

    expect(shared.calls[0]?.facts?.checkedFamilies).toBe('family 1, Ada');
    expect(await freeBusyLedger(ada.userId)).toEqual([true, false]);
    expect(rejoined.calls[0]?.facts?.checkedFamilies).toBe('family 1');
    expect(rejoined.calls[0]?.facts?.askFamilies).toBe('Ada, family 3');

    // Positive control: Ada's own ask after re-joining counts again.
    await turn({ reader, write: writer().write }, sender(), 'in-4', ADA, minutesLater(3));
    const asked = writer();
    await turn({ reader, write: asked.write }, sender(), 'in-5', MEI, minutesLater(4));
    expect(asked.calls[0]?.facts?.checkedFamilies).toBe('family 1, Ada');
  });

  it('a say-so from before the current join never opens the calendar', async () => {
    const { ada } = await threeFamilies();
    await db.database.insert(schema.consentRecords).values({
      userId: ada.userId,
      familyId: ada.familyId,
      consentType: 'integration_specific',
      granted: true,
      consentScope: freeBusyScope(CHAT),
      policyVersion: 'test',
      grantedAt: new Date(NOW.getTime() - 86_400_000),
    });
    const { reader } = findTime();
    const { write, calls } = writer();

    await turn({ reader, write }, sender());

    expect(calls[0]?.facts?.checkedFamilies).toBe('family 1');
    expect(calls[0]?.facts?.askFamilies).toBe('family 2, family 3');
  });

  it('a say-so counts only from a parent of the family who has not stopped Hale here', async () => {
    const { ada } = await threeFamilies();
    const bo = await seedParent(BO, 'Bo', ZONE, ada);
    await connectCalendar(bo, [{ start: '2026-10-31T12:00:00Z', end: '2026-11-01T00:00:00Z' }]);
    const { reader } = findTime();
    await turn({ reader, write: writer().write }, sender(), 'in-0', ADA);
    await turn({ reader, write: writer().write }, sender(), 'in-1', BO);
    // Neither change goes through a door that withdraws: only the read can hold the line.
    await db.database
      .update(schema.linqSharedGroupPeople)
      .set({ stoppedAt: NOW })
      .where(eq(schema.linqSharedGroupPeople.phoneE164Hash, phoneBlindIndex(ADA)));
    await db.database
      .delete(schema.familyMembers)
      .where(eq(schema.familyMembers.userId, bo.userId));
    const { write, calls } = writer();

    await turn({ reader, write }, sender(), 'in-2');

    expect(calls[0]?.facts?.checkedFamilies).toBe('family 1');
    expect(calls[0]?.facts?.askFamilies).toBe('family 2, family 3');
  });

  it("a parent's own words withdraw calendar use only: Hale stays, their busy time does not", async () => {
    const { ada } = await threeFamilies();
    const { reader } = findTime();
    await turn({ reader, write: writer().write }, sender(), 'in-0', ADA);

    const withdrawn = await turn(
      { reader: saying('withdraw_calendar'), write: writer().write },
      sender(),
      'in-1',
      ADA,
      minutesLater(1),
    );
    const { write, calls } = writer();
    await turn({ reader, write }, sender(), 'in-2', MEI, minutesLater(2));

    expect(withdrawn).toMatchObject({ handled: true, outcome: 'calendar_withdrawn' });
    expect(await freeBusyLedger(ada.userId)).toEqual([true, false]);
    const people = await db.database
      .select({ stoppedAt: schema.linqSharedGroupPeople.stoppedAt })
      .from(schema.linqSharedGroupPeople)
      .where(eq(schema.linqSharedGroupPeople.phoneE164Hash, phoneBlindIndex(ADA)));
    expect(people[0]?.stoppedAt).toBeNull();
    expect(calls[0]?.facts?.checkedFamilies).toBe('family 1');
    expect(calls[0]?.facts?.askFamilies).toBe('family 2, family 3');
  });

  it('flag off: a calendar-only withdrawal does not change the ledger', async () => {
    const { ada } = await threeFamilies();
    const { reader } = findTime();
    await turn({ reader, write: writer().write }, sender(), 'in-0', ADA);
    vi.stubEnv('LINQ_GROUP_COMMON_TIME_ENABLED', 'false');

    const out = await turn(
      { reader: saying('withdraw_calendar'), write: writer().write },
      sender(),
      'in-1',
      ADA,
      minutesLater(1),
    );

    expect(out).toMatchObject({ handled: false });
    expect(await freeBusyLedger(ada.userId)).toEqual([true]);
  });

  it("a parent's stop in this chat ends their say-so: their busy time is no longer read", async () => {
    const { ada } = await threeFamilies();
    const { reader } = findTime();
    await turn({ reader, write: writer().write }, sender(), 'in-0', ADA);

    await turn(
      { reader: saying('stop_me'), write: writer().write },
      sender(),
      'in-1',
      ADA,
      minutesLater(1),
    );
    const { write, calls } = writer();
    await turn({ reader, write }, sender(), 'in-2', MEI, minutesLater(2));

    expect(await freeBusyLedger(ada.userId)).toEqual([true, false]);
    expect(calls[0]?.facts?.checkedFamilies).toBe('family 1');
    expect(calls[0]?.facts?.askFamilies).toBe('family 2, family 3');
  });

  it("a co-parent's departure ends their say-so in every chat", async () => {
    const { ada } = await threeFamilies();
    const bo = await seedParent(BO, 'Bo', ZONE, ada);
    // Bo: Saturday 08:00 to 20:00 New York.
    await connectCalendar(bo, [{ start: '2026-10-31T12:00:00Z', end: '2026-11-01T00:00:00Z' }]);
    await db.database.insert(schema.consentRecords).values({
      userId: bo.userId,
      familyId: ada.familyId,
      consentType: 'integration_specific',
      granted: true,
      consentScope: freeBusyScope('chat-elsewhere'),
      policyVersion: 'test',
      grantedAt: NOW,
    });
    const { reader } = findTime([FRIDAY]);
    await turn({ reader, write: writer().write }, sender(), 'in-0', BO);
    await turn({ reader, write: writer().write }, sender(), 'in-1', ADA);

    const departed = await departCoParent(db.database, {
      familyId: ada.familyId,
      actorUserId: bo.userId,
      now: minutesLater(1),
    });
    await turn({ reader, write: writer().write }, sender(), 'in-2', MEI, minutesLater(2));

    expect(departed.outcome).toBe('departed');
    expect(await freeBusyLedger(bo.userId)).toEqual([true, false]);
    const elsewhere = await db.database
      .select({ granted: schema.consentRecords.granted })
      .from(schema.consentRecords)
      .where(
        and(
          eq(schema.consentRecords.userId, bo.userId),
          eq(schema.consentRecords.consentScope, freeBusyScope('chat-elsewhere')),
        ),
      )
      .orderBy(schema.consentRecords.grantedAt);
    expect(elsewhere.map((row) => row.granted)).toEqual([true, false]);
    // Ada's own say-so still stands, so her family is still read, without Bo's Saturday.
    const [, , after] = await proposedSlots();
    expect(after).toEqual([
      '2026-10-29T23:00:00.000Z',
      '2026-10-31T12:00:00.000Z',
      '2026-11-01T13:00:00.000Z',
    ]);
  });

  it('a parent who leaves the group no longer shapes proposals; one still in it does', async () => {
    const { ada } = await threeFamilies();
    const bo = await seedParent(BO, 'Bo', ZONE, ada);
    // Bo: Saturday 08:00 to 20:00 New York.
    await connectCalendar(bo, [{ start: '2026-10-31T12:00:00Z', end: '2026-11-01T00:00:00Z' }]);
    const { reader } = findTime([FRIDAY]);
    await turn({ reader, write: writer().write }, sender(), 'in-0', ADA);
    await turn({ reader, write: writer().write }, sender(), 'in-1', BO);

    // Linq reports Bo removed from the iMessage group. His family's join stays.
    const removed = await unseatMultiFamilyMember(db.database, {
      chatId: CHAT,
      participantHandle: BO,
      now: minutesLater(1),
    });
    await turn({ reader, write: writer().write }, sender(), 'in-2', MEI, minutesLater(2));

    expect(removed.outcome).toBe('linq_multi_family_unseated');
    expect(await freeBusyLedger(bo.userId)).toEqual([true, false]);
    // Ada is still in the group: her busy Thursday still shapes the times; Bo's Saturday
    // no longer does.
    const [, , after] = await proposedSlots();
    expect(after).toEqual([
      '2026-10-29T23:00:00.000Z',
      '2026-10-31T12:00:00.000Z',
      '2026-11-01T13:00:00.000Z',
    ]);
  });

  it('a seated parent removed from the group stops being read: that family is asked', async () => {
    const { ada, priya } = await threeFamilies();
    await connectCalendar(priya, [{ start: '2026-10-31T12:00:00Z', end: '2026-10-31T14:00:00Z' }]);
    const { reader } = findTime();
    await turn({ reader, write: writer().write }, sender(), 'in-0', ADA);
    await turn({ reader, write: writer().write }, sender(), 'in-1', PRIYA);

    await unseatMultiFamilyMember(db.database, {
      chatId: CHAT,
      participantHandle: ADA,
      now: minutesLater(1),
    });
    const { write, calls } = writer();
    await turn({ reader, write }, sender(), 'in-2', MEI, minutesLater(2));

    expect(await freeBusyLedger(ada.userId)).toEqual([true, false]);
    // Priya is still in the group, so her say-so still stands.
    expect(calls[0]?.facts?.checkedFamilies).toBe('family 1, family 3');
    expect(calls[0]?.facts?.askFamilies).toBe('family 2');
  });

  it('a grant and a withdrawal stamped in the same instant leave no say-so', async () => {
    const { ada } = await threeFamilies();
    const { reader } = findTime();
    // Ada's own ask is her household's join; nothing joins a household for it.
    await turn({ reader, write: writer().write }, sender(), 'in-0', ADA);
    const say = (granted: boolean, at: Date) => ({
      userId: ada.userId,
      familyId: ada.familyId,
      consentType: 'integration_specific' as const,
      granted,
      consentScope: freeBusyScope(CHAT),
      policyVersion: 'test',
      grantedAt: at,
    });
    // The withdrawal is written first, so a tie that let the grant win would read Ada.
    await db.database.insert(schema.consentRecords).values(say(false, minutesLater(1)));
    await db.database.insert(schema.consentRecords).values(say(true, minutesLater(1)));
    const tied = writer();
    await turn({ reader, write: tied.write }, sender(), 'in-1', MEI, minutesLater(2));

    // Positive control: a later lone grant stands.
    await db.database.insert(schema.consentRecords).values(say(true, minutesLater(3)));
    const granted = writer();
    await turn({ reader, write: granted.write }, sender(), 'in-2', MEI, minutesLater(4));

    expect(tied.calls[0]?.facts?.checkedFamilies).toBe('family 1');
    expect(tied.calls[0]?.facts?.askFamilies).toBe('family 2, family 3');
    expect(granted.calls[0]?.facts?.checkedFamilies).toBe('family 1, family 2');
  });

  it("a family's leave stamps its consent rows on the turn's clock, not the database's", async () => {
    const { ada } = await threeFamilies();
    const { reader } = findTime();
    await turn({ reader, write: writer().write }, sender(), 'in-0', ADA);

    // The turn's clock (NOW, in October) runs behind the database clock.
    await turn(
      { reader: saying('leave'), write: writer().write },
      sender(),
      'in-1',
      ADA,
      minutesLater(1),
    );

    const rows = await db.database
      .select({
        type: schema.consentRecords.consentType,
        granted: schema.consentRecords.granted,
        grantedAt: schema.consentRecords.grantedAt,
      })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.familyId, ada.familyId))
      .orderBy(schema.consentRecords.grantedAt, schema.consentRecords.consentType);
    expect(rows).toEqual([
      { type: 'integration_specific', granted: true, grantedAt: NOW },
      { type: 'multi_family_group', granted: true, grantedAt: NOW },
      { type: 'integration_specific', granted: false, grantedAt: minutesLater(1) },
      { type: 'multi_family_group', granted: false, grantedAt: minutesLater(1) },
    ]);
  });

  it("a guest's ask for a time reads no calendar: it is an ordinary answer", async () => {
    await threeFamilies();
    const { reader } = findTime([FRIDAY]);
    await turn({ reader, write: writer().write }, sender(), 'in-0', ADA);
    const { write, calls } = writer();
    const wire = sender();

    const out = await turn({ reader, write }, wire, 'in-1', GUEST);

    expect(out).toMatchObject({ handled: true, outcome: 'shared_reply' });
    expect(wire.texts).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(await proposedSlots()).toHaveLength(1);
    // Positive control: a parent's ask in the same chat still proposes.
    const parent = writer();
    await turn({ reader, write: parent.write }, sender(), 'in-2', MEI);
    expect(parent.calls).toHaveLength(1);
    expect(await proposedSlots()).toHaveLength(2);
  });

  it('the first proposal built from busy times says so; a later one does not', async () => {
    await threeFamilies();
    const { reader } = findTime();
    const first = writer();
    await turn({ reader, write: first.write }, sender(), 'in-0', ADA);
    const second = writer();
    await turn({ reader, write: second.write }, sender(), 'in-1', MEI, minutesLater(1));

    expect(first.calls[0]?.facts?.fromBusyTimes).toBe(
      'first time using the busy times those families shared',
    );
    expect(second.calls[0]?.facts?.fromBusyTimes).toBeUndefined();
  });

  it('sends nothing when the AI cannot write the line, and names it', async () => {
    await threeFamilies();
    const { reader } = findTime();
    const { write } = writer(null);
    const wire = sender();

    const out = await turn({ reader, write }, wire);

    expect(out).toMatchObject({ handled: true, outcome: 'common_time_unsent', count: 'ignored' });
    expect(wire.texts).toEqual([]);
  });

  it('flag off: a find-time ask is an ordinary answer and no calendar is read', async () => {
    vi.stubEnv('LINQ_GROUP_COMMON_TIME_ENABLED', 'false');
    await threeFamilies();
    const { reader, seen } = findTime([FRIDAY]);
    const { write, calls } = writer();
    const wire = sender();

    const out = await turn({ reader, write }, wire);

    expect(out).toMatchObject({ handled: true, outcome: 'shared_reply' });
    expect(wire.texts).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(seen[0]?.clock).toBeUndefined();
  });
});
