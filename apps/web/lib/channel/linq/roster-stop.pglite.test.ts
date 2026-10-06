import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { groupAudienceAllows } from './group-audience';
import { fakeGroupOnboardingComposer } from './group-onboarding-voice-fake';
import { handleLinqInboundRequest } from './inbound';
import type { LinqInboundText } from './payload';
import { removeRosterParticipant, stopInGroup } from './roster-stop';

/**
 * Group onboarding v2: STOP inside the family group is about the group. A member's STOP
 * takes back the seat this group gave them and holds the group; the primary parent's
 * STOP takes Hale out of the group. Nobody's 1:1 channel is revoked. Hale being removed
 * from the chat is the same eject.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const HALE = '+14165550100';
const PARENT = '+14165550111';
const DAD = '+14165550131';
const GRAN = '+14165550132';
const FRIEND = '+14165550133';
const GROUP = 'chat-family-group';
const NOW = new Date('2026-10-06T18:00:00.000Z');

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
  vi.unstubAllGlobals();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

type Seated = { phone: string; role: 'co_parent' | 'grandparent' };

async function seedPerson(
  familyId: string,
  phone: string,
  name: string | null,
  role: 'primary_parent' | 'co_parent' | 'grandparent',
) {
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${phoneBlindIndex(phone)}`, name })
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

/** A confirmed roster: the primary parent, the seated members, and (optionally) one not-family member. */
async function seedConfirmedGroup(seated: Seated[], notFamily: string | null = null) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Riley + kids', provinceOrState: 'ON', linqGroupChatId: GROUP })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const primaryId = await seedPerson(familyId, PARENT, 'Riley', 'primary_parent');
  const [roster] = await db.database
    .insert(schema.linqGroupRosters)
    .values({ chatId: GROUP, familyId, source: 'added_to_existing', status: 'confirmed' })
    .returning({ id: schema.linqGroupRosters.id });
  const rosterId = roster?.id as string;
  await db.database.insert(schema.linqGroupRosterMembers).values({
    rosterId,
    chatId: GROUP,
    phoneE164Encrypted: encryptString(PARENT),
    phoneE164Hash: phoneBlindIndex(PARENT),
    knownUserId: primaryId,
    status: 'known_parent',
  });
  const users: Record<string, string> = {};
  for (const person of seated) {
    const userId = await seedPerson(familyId, person.phone, null, person.role);
    users[person.phone] = userId;
    await db.database.insert(schema.linqGroupRosterMembers).values({
      rosterId,
      chatId: GROUP,
      phoneE164Encrypted: encryptString(person.phone),
      phoneE164Hash: phoneBlindIndex(person.phone),
      userId,
      status: 'confirmed',
      confirmedRole: person.role,
    });
    await db.database.insert(schema.linqGroupMembers).values({
      familyId,
      chatId: GROUP,
      userId,
      phoneE164Encrypted: encryptString(person.phone),
      phoneE164Hash: phoneBlindIndex(person.phone),
      role: person.role === 'co_parent' ? 'co_parent' : 'other_family',
      seatedAt: NOW,
    });
    await db.database.insert(schema.consentRecords).values({
      userId,
      familyId,
      consentType:
        person.role === 'co_parent' ? 'sms_service_messages' : 'caregiver_scoped_messages',
      granted: true,
      consentScope:
        person.role === 'co_parent' ? 'linq_group_role_reply' : `caregiver:${person.role}`,
      policyVersion: 'test',
      evidence: { verbatimReply: 'seeded' },
    });
  }
  if (notFamily) {
    await db.database.insert(schema.linqGroupRosterMembers).values({
      rosterId,
      chatId: GROUP,
      phoneE164Encrypted: encryptString(notFamily),
      phoneE164Hash: phoneBlindIndex(notFamily),
      status: 'not_family',
    });
  }
  return { familyId, primaryId, rosterId, users };
}

function ports() {
  const sends: Array<{ chatId: string; text: string; replyTo?: string }> = [];
  const direct: Array<{ to: string; body: string }> = [];
  return {
    sends,
    direct,
    ports: {
      now: NOW,
      voice: fakeGroupOnboardingComposer(),
      send: async (input: { chatId: string; text: string; replyTo?: string }) => {
        sends.push(input);
        return { providerMessageId: `out-${sends.length}` };
      },
      oneToOne: {
        text: async (input: { to: string; body: string }) => {
          direct.push(input);
          return { providerMessageId: 'direct-1', chatId: 'chat-direct' };
        },
        link: async () => ({ providerMessageId: 'direct-link' }),
      },
      recordInbound: async () => 'in-row',
    },
  };
}

function stop(sender: string, messageId = 'in-stop'): LinqInboundText {
  return {
    messageId,
    chatId: GROUP,
    senderHandle: sender,
    text: 'STOP',
    mediaCount: 0,
    receivedAt: NOW,
    otherHandles: [],
  };
}

async function memberStatus(phone: string) {
  const rows = await db.database
    .select({
      hash: schema.linqGroupRosterMembers.phoneE164Hash,
      status: schema.linqGroupRosterMembers.status,
    })
    .from(schema.linqGroupRosterMembers);
  return rows.filter((row) => row.hash === phoneBlindIndex(phone)).map((row) => row.status);
}

async function familyRoles(familyId: string) {
  const rows = await db.database
    .select({ role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
  return rows.map((row) => row.role).sort();
}

async function liveChannel(userId: string) {
  const [row] = await db.database
    .select({ revokedAt: schema.parentChannels.revokedAt })
    .from(schema.parentChannels)
    .where(eq(schema.parentChannels.userId, userId));
  return row ? row.revokedAt === null : null;
}

async function groupChat(familyId: string) {
  const [row] = await db.database
    .select({ chatId: schema.families.linqGroupChatId })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  return row?.chatId ?? null;
}

describe('stopInGroup', () => {
  it("takes back a grandparent's group seat, holds the group, and leaves their 1:1 alone", async () => {
    const seeded = await seedConfirmedGroup([
      { phone: DAD, role: 'co_parent' },
      { phone: GRAN, role: 'grandparent' },
    ]);
    const granId = seeded.users[GRAN] as string;
    expect((await groupAudienceAllows(db.database, GROUP, 'schedule')).allowed).toBe(true);
    const { ports: p, sends, direct } = ports();

    const turn = await stopInGroup(db.database, stop(GRAN, 'in-gran-stop'), p);

    expect(turn).toMatchObject({ handled: true, outcome: 'group_stop_unseated' });
    expect(await memberStatus(GRAN)).toEqual(['declined']);
    expect(await familyRoles(seeded.familyId)).toEqual(['co_parent', 'primary_parent']);
    const [seat] = await db.database
      .select({ removedAt: schema.linqGroupMembers.removedAt })
      .from(schema.linqGroupMembers)
      .where(eq(schema.linqGroupMembers.userId, granId));
    expect(seat?.removedAt).toEqual(NOW);
    const withdrawn = await db.database
      .select({ granted: schema.consentRecords.granted, scope: schema.consentRecords.consentScope })
      .from(schema.consentRecords)
      .where(
        and(eq(schema.consentRecords.userId, granId), eq(schema.consentRecords.granted, false)),
      );
    expect(withdrawn).toEqual([{ granted: false, scope: 'caregiver:grandparent' }]);
    expect(await liveChannel(granId)).toBe(true);
    expect(await groupAudienceAllows(db.database, GROUP, 'schedule')).toEqual({
      allowed: false,
      reason: 'group_audience_empty',
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ chatId: GROUP, replyTo: 'in-gran-stop' });
    expect(sends[0]?.text).toMatch(/^stop_ack:/);
    expect(await groupChat(seeded.familyId)).toBe(GROUP);
    expect(direct.map((text) => [text.to, text.body])).toEqual([
      [PARENT, expect.stringMatching(/^group_quiet_notice: stopped, 1/)],
    ]);
  });

  it("closes a co-parent's group seat on their STOP but keeps them a parent of the family", async () => {
    const seeded = await seedConfirmedGroup([{ phone: DAD, role: 'co_parent' }]);
    const dadId = seeded.users[DAD] as string;
    const { ports: p, sends } = ports();

    const turn = await stopInGroup(db.database, stop(DAD), p);

    expect(turn).toMatchObject({ handled: true, outcome: 'group_stop_unseated' });
    expect(await memberStatus(DAD)).toEqual(['declined']);
    expect(await familyRoles(seeded.familyId)).toEqual(['co_parent', 'primary_parent']);
    expect(await liveChannel(dadId)).toBe(true);
    expect((await groupAudienceAllows(db.database, GROUP, 'schedule')).allowed).toBe(false);
    expect(sends).toHaveLength(1);
  });

  it("takes Hale out of the group on the primary parent's STOP, with one ack, and keeps their 1:1", async () => {
    const seeded = await seedConfirmedGroup([
      { phone: DAD, role: 'co_parent' },
      { phone: GRAN, role: 'grandparent' },
    ]);
    const { ports: p, sends } = ports();

    const turn = await stopInGroup(db.database, stop(PARENT, 'in-parent-stop'), p);

    expect(turn).toMatchObject({ handled: true, outcome: 'group_stop_ejected' });
    expect(await groupChat(seeded.familyId)).toBeNull();
    const [roster] = await db.database.select().from(schema.linqGroupRosters);
    expect(roster?.status).toBe('ejected');
    expect(await familyRoles(seeded.familyId)).toEqual(['co_parent', 'primary_parent']);
    expect(await liveChannel(seeded.primaryId)).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ chatId: GROUP, replyTo: 'in-parent-stop' });
    const verbs = (
      await db.database
        .select({ actionTaken: schema.auditLog.actionTaken })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.familyId, seeded.familyId))
    ).map((row) => row.actionTaken);
    expect(verbs).toContain('linq_group_stop');
    expect(verbs).toContain('linq_group_ejected');
  });

  it('leaves a chat with no household roster to the existing door', async () => {
    const { ports: p, sends } = ports();
    expect(await stopInGroup(db.database, stop(FRIEND), p)).toEqual({ handled: false });
    expect(sends).toEqual([]);
  });
});

describe('removeRosterParticipant', () => {
  it('lets the group speak again once the person who was not family is removed', async () => {
    await seedConfirmedGroup([{ phone: GRAN, role: 'grandparent' }], FRIEND);
    expect((await groupAudienceAllows(db.database, GROUP, 'schedule')).allowed).toBe(false);

    const removed = await removeRosterParticipant(db.database, {
      chatId: GROUP,
      participantHandle: FRIEND,
      now: NOW,
    });

    expect(removed).toEqual({ outcome: 'roster_member_removed', role: null });
    expect(await memberStatus(FRIEND)).toEqual(['removed']);
    expect(await groupAudienceAllows(db.database, GROUP, 'schedule')).toEqual({
      allowed: true,
      reason: 'in_scope',
    });
    expect((await groupAudienceAllows(db.database, GROUP, 'registration')).allowed).toBe(false);
  });

  it('takes away a co-parent seat this group granted when they are removed from the chat', async () => {
    const seeded = await seedConfirmedGroup([{ phone: DAD, role: 'co_parent' }]);

    const removed = await removeRosterParticipant(db.database, {
      chatId: GROUP,
      participantHandle: DAD,
      now: NOW,
    });

    expect(removed).toEqual({ outcome: 'roster_member_removed', role: 'co_parent' });
    expect(await familyRoles(seeded.familyId)).toEqual(['primary_parent']);
    expect(await memberStatus(DAD)).toEqual(['removed']);
    const unseated = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_member_unseated'));
    expect(unseated).toEqual([{ after: { role: 'co_parent', via: 'participant_removed' } }]);
  });
});

describe('the Linq door', () => {
  const SECRET_BYTES = Buffer.alloc(32, 9);
  const TS = String(Math.floor(NOW.getTime() / 1000));

  function signed(body: unknown): Request {
    const raw = JSON.stringify(body);
    const mac = createHmac('sha256', SECRET_BYTES).update(`evt_stop.${TS}.${raw}`).digest('base64');
    return new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'evt_stop',
        'webhook-timestamp': TS,
        'webhook-signature': `v1,${mac}`,
      },
      body: raw,
    });
  }

  function removed(handle: string, isMe: boolean) {
    return {
      api_version: 'v3',
      webhook_version: '2026-02-03',
      event_type: 'participant.removed',
      event_id: 'evt_stop',
      created_at: NOW.toISOString(),
      data: {
        chat_id: GROUP,
        handle,
        participant: { handle, is_me: isMe, service: 'iMessage', status: 'removed' },
      },
    };
  }

  function deps() {
    const outcomes: string[] = [];
    return {
      outcomes,
      deps: {
        database: db.database,
        log: { info: () => {}, warn: () => {}, error: () => {} },
        countOutcome: async (outcome: string) => {
          outcomes.push(outcome);
        },
        enqueue: async () => {},
        now: () => NOW,
        groupVoice: fakeGroupOnboardingComposer(),
      } as unknown as Parameters<typeof handleLinqInboundRequest>[1],
    };
  }

  beforeEach(() => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_WEBHOOK_SECRET', `whsec_${SECRET_BYTES.toString('base64')}`);
  });

  it('ejects the household group when Hale is removed from it, and sends nothing', async () => {
    const seeded = await seedConfirmedGroup([{ phone: GRAN, role: 'grandparent' }]);
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetchMock);
    const { deps: d } = deps();

    const response = await handleLinqInboundRequest(signed(removed(HALE, true)), d);

    expect(await response.json()).toMatchObject({ outcome: 'ejected' });
    expect(await groupChat(seeded.familyId)).toBeNull();
    expect(await familyRoles(seeded.familyId)).toEqual(['primary_parent']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('removes a member through the roster when someone else is taken out of the chat', async () => {
    await seedConfirmedGroup([{ phone: GRAN, role: 'grandparent' }], FRIEND);
    const { deps: d } = deps();

    const response = await handleLinqInboundRequest(signed(removed(FRIEND, false)), d);

    expect(await response.json()).toMatchObject({ outcome: 'roster_member_removed' });
    expect(await memberStatus(FRIEND)).toEqual(['removed']);
  });

  it('closes a legacy group seat the roster never listed when that person is taken out', async () => {
    vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'true');
    const seeded = await seedConfirmedGroup([]);
    const [user] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `sms:${phoneBlindIndex(FRIEND)}`, name: null })
      .returning({ id: schema.users.id });
    await db.database.insert(schema.linqGroupMembers).values({
      familyId: seeded.familyId,
      chatId: GROUP,
      userId: user?.id as string,
      phoneE164Encrypted: encryptString(FRIEND),
      phoneE164Hash: phoneBlindIndex(FRIEND),
      role: 'other_family',
      seatedAt: NOW,
    });
    const { deps: d } = deps();

    const response = await handleLinqInboundRequest(signed(removed(FRIEND, false)), d);

    expect(await response.json()).toMatchObject({ outcome: 'group_member_unseated' });
    const seats = await db.database
      .select({ removedAt: schema.linqGroupMembers.removedAt })
      .from(schema.linqGroupMembers)
      .where(eq(schema.linqGroupMembers.phoneE164Hash, phoneBlindIndex(FRIEND)));
    expect(seats).toEqual([{ removedAt: NOW }]);
  });
});
