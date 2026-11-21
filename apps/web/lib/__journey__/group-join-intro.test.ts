import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeGroupOnboardingComposer } from '~/lib/channel/linq/group-onboarding-voice-fake';
import { handleLinqInboundRequest } from '~/lib/channel/linq/inbound';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { pinnedNow } from '~/lib/testing/clock';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';

/**
 * VIL-727, END TO END AT THE DOOR — Hale is added to a family's group.
 *
 * Lit, the one line Hale says is the join intro: the ground rules, and the who's-who ask
 * when someone needs asking. In a group where everyone is already known, where today
 * Hale says nothing, it says the intro with no question. Dark, the door is unchanged: the
 * roster ask where someone needs asking, and silence where nobody does.
 *
 * WHAT IS FAKED, and only this: Linq's HTTP API behind one stubbed `fetch`, and the group
 * composer (plumbing only; the words are the eval's). The signed webhook, the roster, the
 * claim and the ledger are production code over real Postgres.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET_BYTES = Buffer.alloc(32, 9);
const HALE = '+14165550100';
const PARENT = '+14165550111';
const DAD = '+14165550131';
const GRAN = '+14165550132';
const FRIEND = '+14165550133';
const CHAT = 'chat-family-group';
const NOW = pinnedNow();
const TS = String(Math.floor(NOW.getTime() / 1000));

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
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_WEBHOOK_SECRET', `whsec_${SECRET_BYTES.toString('base64')}`);
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_TURN_AI_ENABLED', 'true');
  vi.stubEnv('GROUP_JOIN_INTRO_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
  await db.exec('truncate table linq_group_rosters cascade');
});

/** Linq, as seen from Hale's side: the members of CHAT, and every bubble Hale posted there. */
function linq(members: readonly string[]) {
  const group: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname.replace('/api/partner/v3', '');
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (init?.method === 'GET' && path === `/chats/${CHAT}`) {
        return Response.json({
          id: CHAT,
          is_group: true,
          handles: members.map((handle) => ({ handle, is_me: handle === HALE })),
        });
      }
      if (init?.method === 'POST' && path === `/chats/${CHAT}/messages`) {
        for (const part of body.message.parts) group.push(part.value);
        return Response.json({ message: { id: `msg-${group.length}` } });
      }
      return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
    }),
  );
  return { group };
}

function signed(body: unknown): Request {
  const raw = JSON.stringify(body);
  const mac = createHmac('sha256', SECRET_BYTES)
    .update(`evt_join_intro.${TS}.${raw}`)
    .digest('base64');
  return new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': 'evt_join_intro',
      'webhook-timestamp': TS,
      'webhook-signature': `v1,${mac}`,
    },
    body: raw,
  });
}

const haleAdded = {
  api_version: 'v3',
  webhook_version: '2026-02-03',
  event_type: 'participant.added',
  event_id: 'evt_join_intro',
  created_at: NOW.toISOString(),
  data: {
    chat_id: CHAT,
    handle: HALE,
    participant: { handle: HALE, is_me: true, service: 'iMessage', status: 'active' },
  },
};

function door() {
  const voice = fakeGroupOnboardingComposer();
  const deps = {
    database: db.database,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    countOutcome: async () => {},
    enqueue: async () => {},
    now: () => NOW,
    groupVoice: voice,
  } as unknown as Parameters<typeof handleLinqInboundRequest>[1];
  const post = async (body: unknown) => {
    const response = await handleLinqInboundRequest(signed(body), deps);
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  };
  return { post, voice };
}

async function seedParent(
  familyId: string,
  phone: string,
  name: string,
  role: 'primary_parent' | 'co_parent',
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
}

async function seedHousehold(options: { coparent?: boolean } = {}) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Riley + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  await seedParent(familyId, PARENT, 'Riley', 'primary_parent');
  if (options.coparent) await seedParent(familyId, DAD, 'Morgan', 'co_parent');
  return familyId;
}

describe('Hale is added to a family group, join intro lit', () => {
  it('says the intro with the ask, once, when someone needs asking', async () => {
    await seedHousehold();
    const wire = linq([HALE, PARENT, DAD, GRAN, FRIEND]);
    const { post, voice } = door();

    const added = await post(haleAdded);

    expect(added).toMatchObject({ outcome: 'roster_matched', ask: 'group_intro_sent' });
    expect(wire.group).toHaveLength(1);
    expect(wire.group[0]).toMatch(/^join_intro:/);
    expect(wire.group[0]).toContain('Hale');
    expect(wire.group[0]).toContain('Riley');
    expect(wire.group[0]?.endsWith('?')).toBe(true);
    expect(voice.calls.map((call) => call.input.kind)).toEqual(['join_intro']);

    // The second signal for the same join (Linq sends a pair) adds nothing.
    const again = await post(haleAdded);
    expect(again).toMatchObject({ outcome: 'roster_already' });
    expect(wire.group).toHaveLength(1);
  });

  it('introduces itself with no question where everyone is already known', async () => {
    await seedHousehold({ coparent: true });
    const wire = linq([HALE, PARENT, DAD]);
    const { post, voice } = door();

    const added = await post(haleAdded);

    expect(added).toMatchObject({
      outcome: 'roster_matched',
      ask: 'group_intro_sent',
    });
    expect(wire.group).toHaveLength(1);
    expect(wire.group[0]).not.toContain('?');
    expect(voice.calls[0]?.input.facts).toMatchObject({ ask: 'none' });
    expect(voice.calls[0]?.input.facts.claims).not.toContain('anyone_can_remove');
  });
});

describe('Hale is added to a family group, join intro dark', () => {
  beforeEach(() => {
    vi.stubEnv('GROUP_JOIN_INTRO_ENABLED', '');
  });

  it('asks who is who exactly as before', async () => {
    await seedHousehold();
    const wire = linq([HALE, PARENT, DAD, GRAN, FRIEND]);
    const { post, voice } = door();

    const added = await post(haleAdded);

    expect(added).toMatchObject({ outcome: 'roster_matched', ask: 'roster_asked' });
    expect(wire.group).toHaveLength(1);
    expect(wire.group[0]).toMatch(/^roster_ask:/);
    expect(voice.calls.map((call) => call.input.kind)).toEqual(['roster_ask']);
  });

  it('stays silent where everyone is already known, as before', async () => {
    await seedHousehold({ coparent: true });
    const wire = linq([HALE, PARENT, DAD]);
    const { post, voice } = door();

    const added = await post(haleAdded);

    expect(added).toEqual({ outcome: 'roster_matched' });
    expect(wire.group).toEqual([]);
    expect(voice.calls).toEqual([]);
  });
});
