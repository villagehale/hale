import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpokenLineRequest } from '~/lib/channel/spoken-line';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { takeMultiFamilyTurn } from './multi-family';
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

function writer(text: string | null = 'written by the model') {
  const calls: SpokenLineRequest[] = [];
  const write = async (request: SpokenLineRequest) => {
    calls.push(request);
    return text;
  };
  return { write, calls };
}

async function seedParent(phone: string, name: string, timezone: string) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'NY' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}-${phone}`, name, timezone })
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

async function connectCalendar(
  parent: { familyId: string; userId: string },
  busy: readonly { start: string; end: string; title?: string }[],
) {
  const [integration] = await db.database
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
      eventId: `event-${index}`,
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
) {
  return takeMultiFamilyTurn(
    db.database,
    {
      chatId: CHAT,
      senderHandle: MEI,
      text: 'Hale, when can all three families do the zoo? Friday is out for us',
      providerMessageId: id,
      receivedAt: NOW,
      now: NOW,
      send: wire.send,
    },
    {
      listHandles: listOf([MEI, ADA, PRIYA]),
      reader: ports.reader,
      composer: fakeSharedGroupComposer(),
      commonTimeWriter: ports.write,
    },
  );
}

// Friday Oct 30, all day in New York.
const FRIDAY = { start: new Date('2026-10-30T04:00:00Z'), end: new Date('2026-10-31T04:00:00Z') };

describe('common time in a shared group', () => {
  it('proposes times that avoid every calendar and what the chat ruled out, and asks the family Hale cannot see', async () => {
    await threeFamilies();
    const { reader, seen } = findTime([FRIDAY]);
    const { write, calls } = writer();
    const wire = sender();

    const out = await turn({ reader, write }, wire);

    expect(out).toMatchObject({ handled: true, outcome: 'common_time_proposed', count: 'intake' });
    expect(wire.texts).toEqual(['written by the model']);
    expect(seen[0]?.clock).toEqual({ now: NOW.toISOString(), timeZone: ZONE });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.purpose).toBe('group_common_time');
    expect(calls[0]?.facts?.checkedFamilies).toBe('Mei, Ada');
    expect(calls[0]?.facts?.askFamilies).toBe('Priya');
    expect(calls[0]?.facts?.proposalCount).toBe('3');
    expect(JSON.stringify(calls)).not.toContain(PRIVATE_TITLE);

    const [row] = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_multi_family_common_time_proposed'));
    // Not Wednesday (Mei), not Thursday before 19:00 (Ada), not Friday (the chat), and
    // inside 08:00 to 21:00 New York for every family, Priya included.
    expect((row?.after as { slots: string[] }).slots).toEqual([
      '2026-10-29T23:00:00.000Z',
      '2026-10-31T12:00:00.000Z',
      '2026-11-01T13:00:00.000Z',
    ]);
    expect(row?.after).toMatchObject({ checked: 2, asked: 1, ruledOut: 1, notice: 'sent' });
  });

  it('reads no calendar a family has not consented to share in this chat: that family is asked', async () => {
    const { ada } = await threeFamilies();
    // The first turn links every known number; Ada's consent is revoked after that.
    const { reader } = findTime();
    const first = writer();
    await turn({ reader, write: first.write }, sender(), 'in-0');
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

    expect(first.calls[0]?.facts?.checkedFamilies).toBe('Mei, Ada');
    expect(calls[0]?.facts?.checkedFamilies).toBe('Mei');
    expect(calls[0]?.facts?.askFamilies).toBe('Ada, Priya');
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
