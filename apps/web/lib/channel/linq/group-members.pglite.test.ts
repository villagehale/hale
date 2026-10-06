import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { fakeSpokenLineComposer } from '../voice/fakes';
import {
  askParticipantAdded,
  declinePrivilegedGroupSeat,
  dutyAssigneeIds,
  unseatParticipantRemoved,
} from './group-members';
import { startGroupRoster } from './roster';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT = '+14165550111';
const FROM = '+14165550100';
const NOW = new Date('2026-09-30T18:00:00.000Z');
const CHAT = 'chat-household-group';

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
  vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

function sender() {
  const texts: string[] = [];
  const send = async (notice: { chatId: string; text: string }) => {
    texts.push(notice.text);
    return { providerMessageId: `msg-${texts.length}` };
  };
  return { send, texts };
}

async function seedFamily(phone: string, name: string) {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: name,
      provinceOrState: 'ON',
      linqGroupChatId: phone === PARENT ? CHAT : null,
    })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}`, name })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId,
    userId,
    role: 'primary_parent',
  });
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

/** The household's roster as Hale read it when it was added: just the parent. */
async function rosterOf(handles: string[]) {
  const started = await startGroupRoster(db.database, {
    chatId: CHAT,
    source: 'added_to_existing',
    now: NOW,
    listHandles: async () => ({ status: 'ok', handles, isGroup: true }),
  });
  expect(started).toMatchObject({ outcome: 'roster_matched' });
}

async function seat(familyId: string, phone: string, role: 'co_parent' | 'other_family') {
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${phoneBlindIndex(phone)}` })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId, role: role === 'co_parent' ? 'co_parent' : 'grandparent' });
  await db.database.insert(schema.linqGroupMembers).values({
    familyId,
    chatId: CHAT,
    userId,
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    role,
  });
  return userId;
}

async function rosterMember(phone: string) {
  const [row] = await db.database
    .select({ status: schema.linqGroupRosterMembers.status })
    .from(schema.linqGroupRosterMembers)
    .where(eq(schema.linqGroupRosterMembers.phoneE164Hash, phoneBlindIndex(phone)));
  return row?.status ?? null;
}

describe('linq group members', () => {
  it('asks someone added to the group, once, and seats nobody on the add', async () => {
    await seedFamily(PARENT, 'Barton');
    await rosterOf([PARENT]);
    const wire = sender();
    const voice = fakeSpokenLineComposer();

    const first = await askParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550122',
      now: NOW,
      voice,
      send: wire.send,
    });
    expect(first).toEqual({
      outcome: 'member_asked',
      notice: { outcome: 'sent', source: 'composed' },
    });
    expect(voice.calls.map((call) => call.input.kind)).toEqual(['member_ask']);
    expect(wire.texts).toHaveLength(1);
    expect(await rosterMember('+14165550122')).toBe('asked');

    const again = await askParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550122',
      now: NOW,
      voice,
      send: wire.send,
    });
    expect(again).toEqual({ outcome: 'member_already' });
    expect(wire.texts).toHaveLength(1);
    expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
    expect(await db.database.select().from(schema.consentRecords)).toEqual([]);
    const roles = await db.database
      .select({ role: schema.familyMembers.role })
      .from(schema.familyMembers);
    expect(roles).toEqual([{ role: 'primary_parent' }]);
  });

  it('refuses a phone that already belongs to another family, and ignores Hale and non-phones', async () => {
    await seedFamily(PARENT, 'Barton');
    await seedFamily('+14165550888', 'Other');
    await rosterOf([PARENT]);
    const wire = sender();
    const voice = fakeSpokenLineComposer();

    const other = await askParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550888',
      now: NOW,
      voice,
      send: wire.send,
    });
    expect(other).toEqual({ outcome: 'group_member_refused', reason: 'other_family' });
    for (const handle of [FROM, 'camp-bot@example.com']) {
      expect(
        await askParticipantAdded(db.database, {
          chatId: CHAT,
          participantHandle: handle,
          now: NOW,
          voice,
          send: wire.send,
        }),
      ).toEqual({ outcome: 'ignored' });
    }
    expect(wire.texts).toEqual([]);
    expect(voice.calls).toEqual([]);
  });

  it('says the chat is not claimed rather than asking into it', async () => {
    const wire = sender();
    expect(
      await askParticipantAdded(db.database, {
        chatId: 'chat-nobody-claimed',
        participantHandle: '+14165550122',
        now: NOW,
        voice: fakeSpokenLineComposer(),
        send: wire.send,
      }),
    ).toEqual({ outcome: 'group_unclaimed' });
    expect(wire.texts).toEqual([]);
  });

  it('unseats on removal', async () => {
    const seeded = await seedFamily(PARENT, 'Barton');
    await seat(seeded.familyId, '+14165550199', 'other_family');
    const removed = await unseatParticipantRemoved(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550199',
      now: NOW,
    });
    expect(removed.outcome).toBe('group_member_unseated');
    const rows = await db.database
      .select({ removedAt: schema.linqGroupMembers.removedAt })
      .from(schema.linqGroupMembers);
    expect(rows[0]?.removedAt).toEqual(NOW);
    const again = await unseatParticipantRemoved(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550199',
      now: NOW,
    });
    expect(again.outcome).toBe('group_member_absent');
  });

  it('lets any live member take a duty and blocks privileged actions for the others', async () => {
    const seeded = await seedFamily(PARENT, 'Barton');
    await seat(seeded.familyId, '+14165550122', 'co_parent');
    const otherUserId = await seat(seeded.familyId, '+14165550133', 'other_family');
    const withMembers = await dutyAssigneeIds(db.database, seeded.familyId);
    expect(withMembers).toEqual(expect.arrayContaining([seeded.userId, otherUserId]));
    expect(withMembers).toHaveLength(3);

    vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'false');
    const parentsOnly = await dutyAssigneeIds(db.database, seeded.familyId);
    expect(parentsOnly).toHaveLength(2);
    expect(parentsOnly).not.toContain(otherUserId);

    vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'true');
    const blocked = await declinePrivilegedGroupSeat(db.database, {
      familyId: seeded.familyId,
      userId: otherUserId,
      capability: 'calendar_email',
    });
    expect(blocked).toBe(true);
    const audits = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_member_refused'));
    expect(
      audits.some((row) => (row.after as { capability?: string }).capability === 'calendar_email'),
    ).toBe(true);
  });

  it('does nothing when group onboarding v2 is off', async () => {
    await seedFamily(PARENT, 'Barton');
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'false');
    const wire = sender();
    const asked = await askParticipantAdded(db.database, {
      chatId: CHAT,
      participantHandle: '+14165550122',
      now: NOW,
      voice: fakeSpokenLineComposer(),
      send: wire.send,
    });
    expect(asked).toEqual({ outcome: 'flag_off' });
    expect(wire.texts).toEqual([]);
    expect(await db.database.select().from(schema.linqGroupRosterMembers)).toEqual([]);
    expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
  });
});
