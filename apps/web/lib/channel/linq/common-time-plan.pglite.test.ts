import { schema } from '@hale/db';
import type { CalendarInviteRequest } from '@hale/worker/executor';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { CommonTimePlanPorts } from './common-time-plan';
import {
  type GroupPlanAttendance,
  type GroupPlanMessage,
  groupPlanCopyKey,
} from './group-plan-invites';
import { formatWhen } from './household-calendar';
import { joinFamilyToSharedGroup, takeMultiFamilyTurn } from './multi-family';
import type { ListChatHandles } from './roster';
import type { SharedGroupReadInput, SharedGroupReader } from './shared-group-reading';
import { fakeSharedGroupComposer } from './shared-group-voice-fake';

// VIL-459 — a time picked from Hale's proposal becomes a plan with one calendar copy and
// one invite per family that said it is in.

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

/**
 * The attendance read stands in for the model (its eval covers the reading): a family
 * whose own latest line is "can't make it" is out, any other own line is in. The fan-out
 * still applies the own-word rule.
 */
function planPorts() {
  const invites: CalendarInviteRequest[] = [];
  const reads: GroupPlanMessage[][] = [];
  const ports: CommonTimePlanPorts = {
    reader: {
      async read(input) {
        reads.push([...input.messages]);
        const latest = new Map(input.messages.map((m) => [m.familyId, m.text]));
        return new Map(
          input.families.map((f): [string, GroupPlanAttendance] => {
            const line = latest.get(f.familyId);
            if (line === undefined) return [f.familyId, 'unclear'];
            return [f.familyId, line === "can't make it" ? 'out' : 'in'];
          }),
        );
      },
    },
    invites: {
      async send(request) {
        invites.push(request);
        return { status: 'reported', parents: [] };
      },
    },
    noteWriter: { write: async () => null },
    sendOneToOne: async () => 'failed',
  };
  return { ports, invites, reads };
}

const listOf =
  (handles: readonly string[]): ListChatHandles =>
  async () => ({ status: 'ok', handles: [...handles], isGroup: true });

async function turn(
  reader: SharedGroupReader,
  plan: CommonTimePlanPorts | undefined,
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
      ...(plan ? { commonTimePlan: plan } : {}),
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

async function liveCopyOf(familyId: string) {
  const rows = await db.database
    .select({ deletedAt: schema.familyEvents.deletedAt })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, familyId),
        isNotNull(schema.familyEvents.groupPlanCopyKey),
      ),
    );
  return rows.length === 1 && rows[0]?.deletedAt === null;
}

async function proposal() {
  const [row] = await db.database
    .select({ id: schema.auditLog.id, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.actionTaken, 'linq_multi_family_common_time_proposed'));
  return { id: row?.id as string, slots: (row?.after as { slots: string[] }).slots };
}

describe('a picked common time becomes a plan on each family calendar', () => {
  it('one plan, one copy and one invite per family that said it is in', async () => {
    const { mei, ada, priya } = await threeFamilies();
    const { reader, seen } = script([ask, pickOffered(1), pickOffered(1)]);
    const plan = planPorts();

    await turn(reader, plan.ports, {
      id: 'in-1',
      from: MEI,
      text: 'when can we all do the zoo?',
      minutes: 0,
    });
    const offer = await proposal();
    const picked = await turn(reader, plan.ports, {
      id: 'in-2',
      from: ADA,
      text: 'the second one works for us',
      minutes: 5,
    });
    await turn(reader, plan.ports, { id: 'in-3', from: PRIYA, text: 'same for us', minutes: 9 });

    expect(picked).toMatchObject({ handled: true, outcome: 'common_time_picked', count: 'intake' });
    // The reader saw the times Hale offered that are still ahead (the first, 11:00 today,
    // has passed by the pick), each on the speaker's clock.
    const ahead = offer.slots.slice(1);
    expect(seen[1]?.offered).toEqual(
      ahead.map((slot) => ({ start: slot, local: formatWhen(new Date(slot), ZONE, 'en') })),
    );
    const start = new Date(ahead[1] as string);
    const rows = await copies();
    expect(rows.map((row) => row.familyId).sort()).toEqual([ada.familyId, priya.familyId].sort());
    for (const row of rows) {
      expect(row.title).toBe('Zoo trip');
      expect(row.startsAt).toEqual(start);
      expect(row.endsAt).toEqual(new Date(start.getTime() + 60 * 60_000));
      // One plan: every copy is keyed to the same proposal.
      expect(row.key).toBe(groupPlanCopyKey(offer.id, row.familyId));
    }
    // Mei asked but never said she is in: no copy, no invite.
    expect(rows.some((row) => row.familyId === mei.familyId)).toBe(false);
    expect(plan.invites.map((i) => [i.familyId, i.method])).toEqual([
      [ada.familyId, 'REQUEST'],
      [priya.familyId, 'REQUEST'],
    ]);
    // The ask itself is not read as anyone being in.
    expect(plan.reads[0]?.map((m) => m.text)).toEqual(['the second one works for us']);
    const placed = await db.database
      .select({ familyId: schema.auditLog.familyId, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_multi_family_common_time_placed'));
    expect(placed.map((row) => row.familyId).sort()).toEqual([ada.familyId, priya.familyId].sort());
  });

  it('a family that withdrew its consent for this chat gets no copy and no invite', async () => {
    const { ada, priya } = await threeFamilies();
    const { reader } = script([ask, chatter, pickOffered(0)]);
    const plan = planPorts();

    await turn(reader, plan.ports, {
      id: 'in-1',
      from: MEI,
      text: 'when can we all do the zoo?',
      minutes: 0,
    });
    // Priya says they are in, then her family's consent for this chat is withdrawn.
    await turn(reader, plan.ports, { id: 'in-2', from: PRIYA, text: 'we are in', minutes: 3 });
    const [join] = await db.database
      .select({ consentRecordId: schema.linqMultiFamilyJoins.consentRecordId })
      .from(schema.linqMultiFamilyJoins)
      .where(eq(schema.linqMultiFamilyJoins.familyId, priya.familyId));
    await db.database
      .update(schema.consentRecords)
      .set({ revokedAt: NOW })
      .where(eq(schema.consentRecords.id, join?.consentRecordId as string));
    await turn(reader, plan.ports, { id: 'in-3', from: ADA, text: 'first one for us', minutes: 6 });

    const rows = await copies();
    // Positive control: Ada, who picked, is placed.
    expect(rows.map((row) => row.familyId)).toEqual([ada.familyId]);
    expect(plan.invites.map((i) => i.familyId)).toEqual([ada.familyId]);
    expect(plan.reads[0]?.some((m) => m.familyId === priya.familyId)).toBe(false);
  });

  it('a second pick never makes a second plan: the same time changes nothing, another time moves it', async () => {
    const { ada } = await threeFamilies();
    const { reader } = script([ask, pickOffered(0), pickOffered(0), pickOffered(1)]);
    const plan = planPorts();

    await turn(reader, plan.ports, {
      id: 'in-1',
      from: MEI,
      text: 'when can we all do the zoo?',
      minutes: 0,
    });
    const offer = await proposal();
    await turn(reader, plan.ports, { id: 'in-2', from: ADA, text: 'first one', minutes: 2 });
    await turn(reader, plan.ports, { id: 'in-3', from: ADA, text: 'yes the first', minutes: 4 });

    expect(await copies()).toHaveLength(1);
    expect(plan.invites).toHaveLength(1);

    await turn(reader, plan.ports, {
      id: 'in-4',
      from: ADA,
      text: 'actually the last one',
      minutes: 6,
    });
    const rows = await copies();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.familyId).toBe(ada.familyId);
    expect(rows[0]?.startsAt).toEqual(new Date(offer.slots[2] as string));
    // The move re-invites, on the same copy.
    expect(plan.invites).toHaveLength(2);
    expect(plan.invites[0]?.familyEventId).toBe(plan.invites[1]?.familyEventId);
  });

  it('with the flag off nothing is offered to the reader and nothing is placed', async () => {
    await threeFamilies();
    const { reader } = script([ask, pickOffered(0)]);
    const plan = planPorts();
    await turn(reader, plan.ports, {
      id: 'in-1',
      from: MEI,
      text: 'when can we all do the zoo?',
      minutes: 0,
    });
    vi.stubEnv('LINQ_GROUP_COMMON_TIME_ENABLED', 'false');
    const seenWhenOff = script([() => reading({ intent: 'chatter' })]);

    await turn(seenWhenOff.reader, plan.ports, {
      id: 'in-2',
      from: ADA,
      text: 'first one',
      minutes: 2,
    });

    expect(seenWhenOff.seen[0]?.offered).toBeUndefined();
    expect(await copies()).toHaveLength(0);
    expect(plan.invites).toHaveLength(0);
  });

  it('a pick with no plan sender wired is named, not dropped silently', async () => {
    await threeFamilies();
    const { reader } = script([ask, pickOffered(0)]);
    await turn(reader, undefined, {
      id: 'in-1',
      from: MEI,
      text: 'when can we all do the zoo?',
      minutes: 0,
    });

    const out = await turn(reader, undefined, {
      id: 'in-2',
      from: ADA,
      text: 'first one',
      minutes: 2,
    });

    expect(out).toMatchObject({ handled: true, outcome: 'common_time_pick_unwired' });
    expect(await copies()).toHaveLength(0);
    const picked = await db.database
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.actionTaken, 'linq_multi_family_common_time_picked')));
    expect(picked).toHaveLength(0);
  });
});

describe('only a member whose family is in this chat can pick the time', () => {
  it('a pick from a member whose household never joined writes nothing', async () => {
    const { priya } = await threeFamilies();
    const NANNY = '+16415550401';
    await seedParent(NANNY, 'Nan', 'nanny');
    const { reader } = script([ask, chatter, pickOffered(0), pickOffered(0)]);
    const plan = planPorts();
    const handles = [MEI, ADA, PRIYA, NANNY];

    await turn(
      reader,
      plan.ports,
      { id: 'in-1', from: MEI, text: 'zoo when?', minutes: 0 },
      handles,
    );
    await turn(
      reader,
      plan.ports,
      { id: 'in-2', from: PRIYA, text: 'we are in', minutes: 2 },
      handles,
    );
    const refused = await turn(
      reader,
      plan.ports,
      { id: 'in-3', from: NANNY, text: 'first one', minutes: 4 },
      handles,
    );

    expect(refused).toMatchObject({ handled: true, outcome: 'common_time_pick_not_joined' });
    expect(await copies()).toHaveLength(0);
    expect(plan.invites).toHaveLength(0);
    expect(await pickedRows()).toHaveLength(0);

    // Positive control: the same pick from a joined, consenting parent places the plan.
    await turn(
      reader,
      plan.ports,
      { id: 'in-4', from: PRIYA, text: 'first one', minutes: 6 },
      handles,
    );
    expect((await copies()).map((row) => row.familyId)).toEqual([priya.familyId]);
  });

  it("a pick from a parent whose family's consent for this chat is gone writes nothing", async () => {
    const { ada, priya } = await threeFamilies();
    const { reader } = script([ask, chatter, pickOffered(0), pickOffered(0)]);
    const plan = planPorts();

    await turn(reader, plan.ports, { id: 'in-1', from: MEI, text: 'zoo when?', minutes: 0 });
    await turn(reader, plan.ports, { id: 'in-2', from: PRIYA, text: 'we are in', minutes: 2 });
    const [join] = await db.database
      .select({ consentRecordId: schema.linqMultiFamilyJoins.consentRecordId })
      .from(schema.linqMultiFamilyJoins)
      .where(eq(schema.linqMultiFamilyJoins.familyId, ada.familyId));
    await db.database
      .update(schema.consentRecords)
      .set({ revokedAt: NOW })
      .where(eq(schema.consentRecords.id, join?.consentRecordId as string));
    const refused = await turn(reader, plan.ports, {
      id: 'in-3',
      from: ADA,
      text: 'first one',
      minutes: 4,
    });

    expect(refused).toMatchObject({ handled: true, outcome: 'common_time_pick_not_joined' });
    expect(await copies()).toHaveLength(0);
    expect(plan.invites).toHaveLength(0);
    expect(await pickedRows()).toHaveLength(0);

    // Positive control: Priya's family still consents, and her pick places the plan.
    await turn(reader, plan.ports, { id: 'in-4', from: PRIYA, text: 'first one', minutes: 6 });
    expect((await copies()).map((row) => row.familyId)).toEqual([priya.familyId]);
  });

  it('a reaction from a parent who stopped Hale in this chat picks nothing', async () => {
    const { priya } = await threeFamilies();
    const { reader } = script([ask, chatter, pickOffered(0), pickOffered(0)]);
    const plan = planPorts();

    await turn(reader, plan.ports, { id: 'in-1', from: MEI, text: 'zoo when?', minutes: 0 });
    await turn(reader, plan.ports, { id: 'in-2', from: PRIYA, text: 'we are in', minutes: 2 });
    await db.database
      .update(schema.linqSharedGroupPeople)
      .set({ stoppedAt: NOW })
      .where(eq(schema.linqSharedGroupPeople.phoneE164Hash, phoneBlindIndex(ADA)));
    const refused = await turn(reader, plan.ports, {
      id: 'in-3',
      from: ADA,
      text: '',
      minutes: 4,
      reactionType: 'like',
    });

    expect(refused).toMatchObject({ handled: true, outcome: 'common_time_pick_stopped' });
    expect(await copies()).toHaveLength(0);
    expect(plan.invites).toHaveLength(0);
    expect(await pickedRows()).toHaveLength(0);

    // Positive control: the same reaction from a member who has not stopped places it.
    await turn(reader, plan.ports, {
      id: 'in-4',
      from: PRIYA,
      text: '',
      minutes: 6,
      reactionType: 'like',
    });
    expect((await copies()).map((row) => row.familyId)).toEqual([priya.familyId]);
  });
});

describe("a family's yes is never lost to a busy chat", () => {
  it('a yes said before 30 other lines still places that family when the time is picked', async () => {
    const { ada, priya } = await threeFamilies();
    const busy = Array.from({ length: 32 }, () => chatter);
    const { reader } = script([ask, chatter, ...busy, pickOffered(0)]);
    const plan = planPorts();

    await turn(reader, plan.ports, { id: 'in-1', from: MEI, text: 'zoo when?', minutes: 0 });
    await turn(reader, plan.ports, { id: 'in-2', from: ADA, text: 'we are in', minutes: 1 });
    for (const [i] of busy.entries()) {
      await turn(reader, plan.ports, {
        id: `busy-${i}`,
        from: MEI,
        text: `chatter ${i}`,
        minutes: 2 + i,
      });
    }
    await turn(reader, plan.ports, { id: 'in-3', from: PRIYA, text: 'first works', minutes: 40 });

    expect(await liveCopyOf(ada.familyId)).toBe(true);
    expect(await liveCopyOf(priya.familyId)).toBe(true);
  });

  it("30 lines after a family's yes, a later pick keeps its copy; its own can't-make-it still cancels", async () => {
    const { ada } = await threeFamilies();
    const busy = Array.from({ length: 32 }, () => chatter);
    const { reader } = script([
      ask,
      pickOffered(0),
      ...busy,
      pickOffered(0),
      chatter,
      pickOffered(0),
    ]);
    const plan = planPorts();

    await turn(reader, plan.ports, { id: 'in-1', from: MEI, text: 'zoo when?', minutes: 0 });
    await turn(reader, plan.ports, { id: 'in-2', from: ADA, text: 'first one for us', minutes: 1 });
    expect(await liveCopyOf(ada.familyId)).toBe(true);
    for (const [i] of busy.entries()) {
      await turn(reader, plan.ports, {
        id: `busy-${i}`,
        from: i % 2 === 0 ? MEI : PRIYA,
        text: `chatter ${i}`,
        minutes: 2 + i,
      });
    }
    await turn(reader, plan.ports, { id: 'in-3', from: PRIYA, text: 'first works', minutes: 40 });

    expect(await liveCopyOf(ada.familyId)).toBe(true);
    expect(plan.invites.filter((i) => i.method === 'CANCEL')).toHaveLength(0);

    // Control: Ada's own later word takes her family out.
    await turn(reader, plan.ports, { id: 'in-4', from: ADA, text: "can't make it", minutes: 41 });
    await turn(reader, plan.ports, { id: 'in-5', from: MEI, text: 'first then', minutes: 42 });
    expect(await liveCopyOf(ada.familyId)).toBe(false);
    expect(plan.invites.filter((i) => i.method === 'CANCEL').map((i) => i.familyId)).toEqual([
      ada.familyId,
    ]);
  });
});
