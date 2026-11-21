import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import {
  DROP_SINGLE_OPEN_PLAN_INDEX,
  seedJoinConsent,
  seedTextedHale,
} from '~/lib/testing/group-scenes';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { GroupPlanRsvpReading } from '../group-plan-rsvp/reading';
import { fakeGroupPlanRsvpComposer } from '../group-plan-rsvp/voice-fake';
import { handleLinqInboundRequest } from '../inbound';
import { fakeSharedGroupComposer } from '../shared-group-voice-fake';
import { fakeGroupExperienceComposer } from './voice-fake';

/**
 * VIL-689 scene 01 · Hale added to a group two Hale families already have, through the signed
 * door with production's deps (no injected sender or member list; Linq answered at fetch). The
 * add event lists no members, so the door must read the real list, and a `mixed_family` roster
 * left from before must not hold every plan line.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET = Buffer.alloc(32, 9);
const CHAT = 'chat-existing-group';
const NOW = new Date('2026-11-12T17:00:00.000Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const HALE = '+15555550100';
const PARENT_A = '+15555550171';
const PARENT_B = '+15555550172';

let db: TestDb;
beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
  await db.exec(DROP_SINGLE_OPEN_PLAN_INDEX);
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_FROM_E164', HALE);
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_WEBHOOK_SECRET', `whsec_${SECRET.toString('base64')}`);
  for (const flag of [
    'LINQ_GROUP_SCENES_ENABLED',
    'LINQ_MULTI_FAMILY_GROUPS_ENABLED',
    'LINQ_GROUP_MEMBERS_ENABLED',
    'LINQ_GROUP_ONBOARDING_V2_ENABLED',
    'LINQ_GROUP_PLAN_RSVP_ENABLED',
    'LINQ_GROUP_POLLS_ENABLED',
    'GROUP_POLLS_ENABLED',
    'GROUP_LINK_CARDS_ENABLED',
    'GROUP_PRIVATE_QUESTION_ENABLED',
  ]) {
    vi.stubEnv(flag, 'true');
  }
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table families, users, linq_group_rosters, linq_shared_group_people, linq_multi_family_joins, linq_multi_family_members, linq_group_experience, linq_group_plans, linq_group_polls, consent_records, audit_log, channel_messages cascade',
  );
});

let eventSeq = 0;
function signed(body: unknown): Request {
  eventSeq += 1;
  const id = `evt_existing_group_${eventSeq}`;
  const raw = JSON.stringify(body);
  const mac = createHmac('sha256', SECRET).update(`${id}.${TS}.${raw}`).digest('base64');
  return new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': TS,
      'webhook-signature': `v1,${mac}`,
    },
    body: raw,
  });
}

const envelope = (event_type: string, data: unknown) => ({
  api_version: 'v3',
  webhook_version: '2026-02-03',
  event_type,
  event_id: `evt_${event_type}_${eventSeq}`,
  created_at: NOW.toISOString(),
  data,
});

const haleAdded = () =>
  envelope('participant.added', {
    chat_id: CHAT,
    handle: HALE,
    added_by: PARENT_A,
    participant: { handle: HALE, is_me: true, service: 'iMessage', status: 'active' },
  });

const chatCreated = () =>
  envelope('chat.created', {
    id: CHAT,
    is_group: true,
    handles: [
      { handle: HALE, is_me: true },
      { handle: PARENT_A, is_me: false },
      { handle: PARENT_B, is_me: false },
    ],
  });

const groupMessage = (sender: string, text: string, id: string) =>
  envelope('message.received', {
    chat: { id: CHAT, is_group: true },
    id,
    direction: 'inbound',
    sender_handle: { handle: sender, is_me: false },
    parts: [{ type: 'text', value: text }],
    sent_at: NOW.toISOString(),
    service: 'iMessage',
  });

function linqWire() {
  const posts: { url: string; body: string }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      const chat = {
        id: CHAT,
        is_group: true,
        handles: [
          { handle: HALE, is_me: true },
          { handle: PARENT_A, is_me: false },
          { handle: PARENT_B, is_me: false },
        ],
      };
      return Response.json({ ...chat, chat });
    }
    if (String(url).endsWith('/messages')) {
      posts.push({ url: String(url), body: String(init?.body ?? '') });
      return Response.json({ message: { id: `out-${posts.length}` } }, { status: 201 });
    }
    return Response.json({}, { status: 200 });
  });
  return posts;
}

async function seedFamily(phone: string, name: string) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}`, name, timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
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
  await seedTextedHale(db.database, { familyId, userId, at: new Date(NOW.getTime() - 9e7) });
  return { familyId, userId, phone };
}

/** Both families said "count us in": what the join turn leaves behind. */
async function bothJoined(families: { familyId: string; userId: string; phone: string }[]) {
  for (const family of families) {
    await db.database.insert(schema.linqMultiFamilyJoins).values({
      chatId: CHAT,
      familyId: family.familyId,
      joinedByUserId: family.userId,
      joinedAt: NOW,
    });
    await db.database.insert(schema.linqMultiFamilyMembers).values({
      chatId: CHAT,
      familyId: family.familyId,
      userId: family.userId,
      phoneE164Encrypted: encryptString(family.phone),
      phoneE164Hash: phoneBlindIndex(family.phone),
      role: 'parent',
    });
    await seedJoinConsent(db.database, {
      chatId: CHAT,
      familyId: family.familyId,
      userId: family.userId,
    });
  }
}

const startTracking = {
  intent: 'start_tracking',
  response: null,
  headcount: 1,
  planTitle: 'picnic',
  startsAt: '2026-11-14T11:00:00-05:00',
  location: null,
  deadline: null,
  householdLabel: null,
  coversNames: [],
  confidence: 'high',
  planKey: null,
  replacesPlanKey: null,
  addressed: true,
  pollQuestion: null,
  pollOptions: [],
  pollStarts: [],
  pollChoice: null,
} as GroupPlanRsvpReading;

/** The door as production builds it: no `sendGroupText`, no `listChatHandles`. Models faked. */
function productionDoor() {
  return {
    database: db.database,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    countOutcome: async () => {},
    enqueue: async () => {},
    now: () => NOW,
    markRead: async () => {},
    groupPlanRsvpReader: { read: async () => startTracking },
    groupPlanRsvpComposer: fakeGroupPlanRsvpComposer(),
    groupExperienceReader: {
      read: async () => ({
        kind: 'none',
        title: null,
        samePlan: null,
        response: null,
        optionKey: null,
        options: [],
        starts: [],
        confidence: 'high',
      }),
    },
    groupExperienceComposer: fakeGroupExperienceComposer(),
    sharedGroupVoice: fakeSharedGroupComposer(),
    sharedGroupReader: {
      read: async () => ({
        intent: 'question',
        role: 'unclear',
        familyLabel: null,
        kidName: null,
        confidence: 'high',
      }),
    },
    privateAsideModel: {
      read: async () => [],
      draft: async () => ({ send: false, about: '', text: '' }),
    },
  } as unknown as Parameters<typeof handleLinqInboundRequest>[1];
}

async function rosterStatuses() {
  const rows = await db.database
    .select({ status: schema.linqGroupRosters.status })
    .from(schema.linqGroupRosters);
  return rows.map((row) => row.status);
}

describe('Hale added to a group two Hale families already have (scene 01)', () => {
  it('positive control: a new group, whose event lists its members, gets its hello and plan line', async () => {
    const posts = linqWire();
    const a = await seedFamily(PARENT_A, 'Ada');
    const b = await seedFamily(PARENT_B, 'Bao');
    const add = await handleLinqInboundRequest(signed(chatCreated()), productionDoor());
    expect((await add.json()).outcome).toBe('intro');
    expect(await rosterStatuses()).toEqual([]);
    expect(posts).toHaveLength(1);
    await bothJoined([a, b]);
    await handleLinqInboundRequest(
      signed(groupMessage(PARENT_A, 'Hale, picnic Saturday at 11, who is in?', 'msg-new')),
      productionDoor(),
    );
    expect(posts).toHaveLength(2);
  });

  it('the add event names no members: Hale reads the real list, says hello once, keeps no household roster', async () => {
    const posts = linqWire();
    await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const add = await handleLinqInboundRequest(signed(haleAdded()), productionDoor());
    expect((await add.json()).outcome).toBe('intro');
    expect(posts).toHaveLength(1);
    expect(await rosterStatuses()).toEqual([]);
  });

  it('after the add, a plan line reaches the group once the families have joined', async () => {
    const posts = linqWire();
    const a = await seedFamily(PARENT_A, 'Ada');
    const b = await seedFamily(PARENT_B, 'Bao');
    await handleLinqInboundRequest(signed(haleAdded()), productionDoor());
    await bothJoined([a, b]);
    const before = posts.length;
    const res = await handleLinqInboundRequest(
      signed(groupMessage(PARENT_A, 'Hale, picnic Saturday at 11, who is in?', 'msg-existing')),
      productionDoor(),
    );
    expect((await res.json()).outcome).toBe('group_plan_spoken');
    expect(posts.length - before).toBe(1);
  });

  it('a chat whose roster already reads mixed_family takes the plan line once a family joined', async () => {
    const posts = linqWire();
    const a = await seedFamily(PARENT_A, 'Ada');
    const b = await seedFamily(PARENT_B, 'Bao');
    await db.database
      .insert(schema.linqGroupRosters)
      .values({ chatId: CHAT, familyId: null, source: 'added_to_existing', status: 'mixed_family' });
    await bothJoined([a, b]);
    const res = await handleLinqInboundRequest(
      signed(groupMessage(PARENT_A, 'Hale, picnic Saturday at 11, who is in?', 'msg-mixed')),
      productionDoor(),
    );
    expect((await res.json()).outcome).toBe('group_plan_spoken');
    expect(posts).toHaveLength(1);
  });

  it('with the scenes flag off, the add runs as it does today: no list read for the hello, a mixed roster', async () => {
    vi.stubEnv('LINQ_GROUP_SCENES_ENABLED', '');
    const posts = linqWire();
    await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const add = await handleLinqInboundRequest(signed(haleAdded()), productionDoor());
    expect((await add.json()).outcome).toBe('roster_mixed_family');
    expect(posts).toHaveLength(0);
    expect(await rosterStatuses()).toEqual(['mixed_family']);
  });
});
