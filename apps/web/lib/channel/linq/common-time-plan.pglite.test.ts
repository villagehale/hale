import { schema } from '@hale/db';
import { eq, isNotNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { joinFamilyToSharedGroup, takeMultiFamilyTurn } from './multi-family';
import type { ListChatHandles } from './roster';
import type { SharedGroupReadInput, SharedGroupReader } from './shared-group-reading';
import { fakeSharedGroupComposer } from './shared-group-voice-fake';

// VIL-459 — a time picked from Hale's proposal is recorded. It writes no family's
// calendar copy and sends no invite: only a parent's own 1:1 OK may (VIL-773).

const KEY = Buffer.alloc(32, 7).toString('base64');
const FROM = '+16462352164';
// Wed Oct 28 2026, 11:00 in New York.
const NOW = new Date('2026-10-28T15:00:00.000Z');
const CHAT = 'chat-common-time-plan';
const ZONE = 'America/New_York';

const MEI = '+16415550101';
const ADA = '+16415550201';
const PRIYA = '+16415550301';

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

async function seedParent(
  phone: string,
  name: string,
  role: 'primary_parent' | 'nanny' = 'primary_parent',
) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'NY' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}-${phone}`, name, timezone: ZONE })
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
  return { familyId, userId };
}

async function joined(family: { familyId: string; userId: string }, phone: string) {
  await joinFamilyToSharedGroup(db.database, {
    chatId: CHAT,
    ...family,
    phone,
    verbatim: 'our family is in this group',
    now: NOW,
    send: async () => ({ providerMessageId: `join-${phone}` }),
  });
  return family;
}

async function threeFamilies() {
  return {
    mei: await joined(await seedParent(MEI, 'Mei'), MEI),
    ada: await joined(await seedParent(ADA, 'Ada'), ADA),
    priya: await joined(await seedParent(PRIYA, 'Priya'), PRIYA),
  };
}

/** A scripted read per turn; records what the reader was shown. */
function script(readings: ((input: SharedGroupReadInput) => Parameters<typeof reading>[0])[]) {
  const seen: SharedGroupReadInput[] = [];
  const reader: SharedGroupReader = {
    async read(input) {
      seen.push(input);
      const next = readings[seen.length - 1];
      if (!next) throw new Error('no scripted reading for this turn');
      return reading(next(input));
    },
  };
  return { reader, seen };
}

function reading(over: {
  intent: 'find_time' | 'pick_time' | 'chatter';
  picked?: Date | null;
  planTitle?: string | null;
}) {
  return {
    role: 'unclear' as const,
    familyLabel: null,
    kidName: null,
    confidence: 'high' as const,
    ruledOut: [],
    picked: null,
    planTitle: null,
    ...over,
  };
}

const ask = () => reading({ intent: 'find_time', planTitle: 'Zoo trip' });
const pickOffered =
  (index: number) =>
  (input: SharedGroupReadInput): Parameters<typeof reading>[0] => {
    const start = input.offered?.[index]?.start;
    if (!start) throw new Error('nothing offered');
    return { intent: 'pick_time', picked: new Date(start) };
  };
const chatter = () => reading({ intent: 'chatter' });

const listOf =
  (handles: readonly string[]): ListChatHandles =>
  async () => ({ status: 'ok', handles: [...handles], isGroup: true });

async function turn(
  reader: SharedGroupReader,
  input: { id: string; from: string; text: string; minutes: number; reactionType?: string },
  handles: readonly string[] = [MEI, ADA, PRIYA],
) {
  const at = new Date(NOW.getTime() + input.minutes * 60_000);
  return takeMultiFamilyTurn(
    db.database,
    {
      chatId: CHAT,
      senderHandle: input.from,
      text: input.text,
      providerMessageId: input.id,
      receivedAt: at,
      now: at,
      send: async () => ({ providerMessageId: `out-${input.id}` }),
      ...(input.reactionType ? { reactionType: input.reactionType, targetIsHale: true } : {}),
    },
    {
      listHandles: listOf(handles),
      reader,
      composer: fakeSharedGroupComposer(),
      commonTimeWriter: async () => 'written by the model',
    },
  );
}

async function copies() {
  return db.database
    .select({
      familyId: schema.familyEvents.familyId,
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
      endsAt: schema.familyEvents.endsAt,
      key: schema.familyEvents.groupPlanCopyKey,
    })
    .from(schema.familyEvents)
    .where(isNotNull(schema.familyEvents.groupPlanCopyKey));
}

async function pickedRows() {
  return db.database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.actionTaken, 'linq_multi_family_common_time_picked'));
}

async function proposal() {
  const [row] = await db.database
    .select({ id: schema.auditLog.id, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.actionTaken, 'linq_multi_family_common_time_proposed'));
  return { id: row?.id as string, slots: (row?.after as { slots: string[] }).slots };
}

describe('a picked common time writes no family calendar', () => {
  for (const calendar of ['', 'true'] as const) {
    it(`records the pick and writes no copy (plan calendar flag ${calendar || 'unset'})`, async () => {
      vi.stubEnv('LINQ_GROUP_PLAN_RSVP_CALENDAR_ENABLED', calendar);
      const { ada } = await threeFamilies();
      const { reader } = script([ask, pickOffered(1), pickOffered(1)]);

      await turn(reader, {
        id: 'in-1',
        from: MEI,
        text: 'when can we all do the zoo?',
        minutes: 0,
      });
      const offer = await proposal();
      const picked = await turn(reader, {
        id: 'in-2',
        from: ADA,
        text: 'the second one works for us',
        minutes: 5,
      });
      await turn(reader, { id: 'in-3', from: PRIYA, text: 'same for us', minutes: 9 });

      expect(picked).toMatchObject({
        handled: true,
        outcome: 'common_time_picked',
        notice: 'not_placed',
      });
      expect(await copies()).toEqual([]);
      // Positive control: the pick itself happened and is on the picker's family.
      const rows = await db.database
        .select({ familyId: schema.auditLog.familyId, after: schema.auditLog.after })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.actionTaken, 'linq_multi_family_common_time_picked'));
      expect(rows[0]).toMatchObject({
        familyId: ada.familyId,
        after: { slot: new Date(offer.slots[2] as string).toISOString(), status: 'not_placed' },
      });
      const placed = await db.database
        .select({ id: schema.auditLog.id })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.actionTaken, 'linq_multi_family_common_time_placed'));
      expect(placed).toEqual([]);
    });
  }

  it('with the flag off nothing is offered to the reader and nothing is placed', async () => {
    await threeFamilies();
    const { reader } = script([ask, pickOffered(0)]);
    await turn(reader, {
      id: 'in-1',
      from: MEI,
      text: 'when can we all do the zoo?',
      minutes: 0,
    });
    vi.stubEnv('LINQ_GROUP_COMMON_TIME_ENABLED', 'false');
    const seenWhenOff = script([() => reading({ intent: 'chatter' })]);

    await turn(seenWhenOff.reader, {
      id: 'in-2',
      from: ADA,
      text: 'first one',
      minutes: 2,
    });

    expect(seenWhenOff.seen[0]?.offered).toBeUndefined();
    expect(await copies()).toHaveLength(0);
  });
});

describe('only a member whose family is in this chat can pick the time', () => {
  it('a pick from a member whose household never joined writes nothing', async () => {
    await threeFamilies();
    const NANNY = '+16415550401';
    await seedParent(NANNY, 'Nan', 'nanny');
    const { reader } = script([ask, chatter, pickOffered(0), pickOffered(0)]);
    const handles = [MEI, ADA, PRIYA, NANNY];

    await turn(reader, { id: 'in-1', from: MEI, text: 'zoo when?', minutes: 0 }, handles);
    await turn(reader, { id: 'in-2', from: PRIYA, text: 'we are in', minutes: 2 }, handles);
    const refused = await turn(
      reader,
      { id: 'in-3', from: NANNY, text: 'first one', minutes: 4 },
      handles,
    );

    expect(refused).toMatchObject({ handled: true, outcome: 'common_time_pick_not_joined' });
    expect(await copies()).toHaveLength(0);
    expect(await pickedRows()).toHaveLength(0);

    // Positive control: the same pick from a joined, consenting parent is recorded.
    await turn(reader, { id: 'in-4', from: PRIYA, text: 'first one', minutes: 6 }, handles);
    expect(await pickedRows()).toHaveLength(1);
    expect(await copies()).toHaveLength(0);
  });

  it("a pick from a parent whose family's consent for this chat is gone writes nothing", async () => {
    const { ada } = await threeFamilies();
    const { reader } = script([ask, chatter, pickOffered(0), pickOffered(0)]);

    await turn(reader, { id: 'in-1', from: MEI, text: 'zoo when?', minutes: 0 });
    await turn(reader, { id: 'in-2', from: PRIYA, text: 'we are in', minutes: 2 });
    const [join] = await db.database
      .select({ consentRecordId: schema.linqMultiFamilyJoins.consentRecordId })
      .from(schema.linqMultiFamilyJoins)
      .where(eq(schema.linqMultiFamilyJoins.familyId, ada.familyId));
    await db.database
      .update(schema.consentRecords)
      .set({ revokedAt: NOW })
      .where(eq(schema.consentRecords.id, join?.consentRecordId as string));
    const refused = await turn(reader, {
      id: 'in-3',
      from: ADA,
      text: 'first one',
      minutes: 4,
    });

    expect(refused).toMatchObject({ handled: true, outcome: 'common_time_pick_not_joined' });
    expect(await copies()).toHaveLength(0);
    expect(await pickedRows()).toHaveLength(0);

    // Positive control: Priya's family still consents, and her pick is recorded.
    await turn(reader, { id: 'in-4', from: PRIYA, text: 'first one', minutes: 6 });
    expect(await pickedRows()).toHaveLength(1);
    expect(await copies()).toHaveLength(0);
  });

  it('a reaction from a parent who stopped Hale in this chat picks nothing', async () => {
    await threeFamilies();
    const { reader } = script([ask, chatter, pickOffered(0), pickOffered(0)]);

    await turn(reader, { id: 'in-1', from: MEI, text: 'zoo when?', minutes: 0 });
    await turn(reader, { id: 'in-2', from: PRIYA, text: 'we are in', minutes: 2 });
    await db.database
      .update(schema.linqSharedGroupPeople)
      .set({ stoppedAt: NOW })
      .where(eq(schema.linqSharedGroupPeople.phoneE164Hash, phoneBlindIndex(ADA)));
    const refused = await turn(reader, {
      id: 'in-3',
      from: ADA,
      text: '',
      minutes: 4,
      reactionType: 'like',
    });

    expect(refused).toMatchObject({ handled: true, outcome: 'common_time_pick_stopped' });
    expect(await copies()).toHaveLength(0);
    expect(await pickedRows()).toHaveLength(0);

    // Positive control: the same reaction from a member who has not stopped is recorded.
    await turn(reader, {
      id: 'in-4',
      from: PRIYA,
      text: '',
      minutes: 6,
      reactionType: 'like',
    });
    expect(await pickedRows()).toHaveLength(1);
    expect(await copies()).toHaveLength(0);
  });
});
