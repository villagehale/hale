import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import type { OpsPage } from '~/lib/monitoring/failure-page';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { GROUP_LOOP_GUARD_CAP_DEFAULT } from './group-loop-guard';
import { fakeGroupOnboardingComposer } from './group-onboarding-voice-fake';
import type { GroupTurnReader, GroupTurnReading } from './group-turn-reader';
import { handleLinqInboundRequest } from './inbound';
import type { ListChatHandles } from './roster';
import type { SharedGroupReader } from './shared-group-reading';
import { fakeSharedGroupComposer } from './shared-group-voice-fake';

/**
 * VIL-728 · the loop guard at the real Linq door, signed webhook in, Linq send out.
 *
 * The echo bot is a number nobody verified that repeats every line Hale posts, at once.
 * The model seams are the door's own test seams: the shared-group reader is scripted to
 * read every message as a question for Hale (chosen by the test, never by the words), and
 * the composer writes a numbered line. Neither judges anything the guard decides on: the
 * guard reads who spoke and how many Hale lines the ledger holds, never a message.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET_BYTES = Buffer.alloc(32, 9);
const HALE = '+14165550100';
const MEI = '+14165550111';
const ADA = '+14165550121';
const BOT = '+14165550199';
const CHAT = 'chat-shared-loop';
const HOME_CHAT = 'chat-family-loop';
const NOW = new Date('2026-11-20T15:00:00.000Z');

let db: TestDb;
let clock = NOW;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = NOW;
  vi.setSystemTime(clock);
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_FROM_E164', HALE);
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_WEBHOOK_SECRET', `whsec_${SECRET_BYTES.toString('base64')}`);
  vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'true');
  vi.stubEnv('GROUP_LOOP_GUARD_ENABLED', 'true');
  vi.stubEnv('GROUP_LOOP_GUARD_CAP', '');
  // Paths that would read the same message first, or call a model this file does not
  // script. Set off explicitly: the all-flags-on CI job turns every default-off flag on.
  for (const name of [
    'LINQ_GROUP_PLAN_RSVP_ENABLED',
    'LINQ_GROUP_POLLS_ENABLED',
    'GROUP_POLLS_ENABLED',
    'GROUP_LINK_CARDS_ENABLED',
    'GROUP_PRIVATE_QUESTION_ENABLED',
    'GROUP_SHARED_LISTS_ENABLED',
    'GROUP_BRING_LIST_ENABLED',
    'LINQ_GROUP_COMMON_TIME_ENABLED',
    'LINQ_GROUP_ONBOARDING_V2_ENABLED',
    'LINQ_GROUP_TURN_AI_ENABLED',
    'LINQ_GROUP_MEMBERS_ENABLED',
    'LINQ_GROUP_CARPOOL_ENABLED',
    'GROUP_CARPOOL_ENABLED',
    'LINQ_GROUP_REMINDERS_ENABLED',
    'COPARENT_DUTY_ASKS_ENABLED',
    'SOCIAL_WATCHLIST',
  ]) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('SECRET_SANTA', 'false');
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table linq_group_loop_guards, linq_shared_group_people, linq_multi_family_joins, linq_multi_family_members, linq_multi_family_ledger, linq_group_rosters, audit_log, channel_messages, rate_limits, families, users cascade',
  );
});

function tick(ms = 2_000): void {
  clock = new Date(clock.getTime() + ms);
  vi.setSystemTime(clock);
}

async function seedParent(
  phone: string,
  name: string,
): Promise<{ familyId: string; userId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}`, name })
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

/** Two families in one chat, the first joined, so even a guest's question has a host. */
async function seedSharedChat() {
  const mei = await seedParent(MEI, 'Mei');
  const ada = await seedParent(ADA, 'Ada');
  await db.database.insert(schema.linqMultiFamilyJoins).values({
    chatId: CHAT,
    familyId: mei.familyId,
    joinedByUserId: mei.userId,
    joinedAt: NOW,
  });
  return { mei, ada };
}

let delivery = 0;

function signed(body: unknown): Request {
  delivery += 1;
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(clock.getTime() / 1000));
  const id = `evt_loop_${delivery}`;
  const mac = createHmac('sha256', SECRET_BYTES).update(`${id}.${ts}.${raw}`).digest('base64');
  return new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': ts,
      'webhook-signature': `v1,${mac}`,
    },
    body: raw,
  });
}

function groupText(sender: string, text: string, chatId = CHAT) {
  return {
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: 'message.received',
    event_id: `evt_loop_msg_${delivery + 1}`,
    created_at: clock.toISOString(),
    data: {
      chat: { id: chatId, is_group: true },
      id: `in-${delivery + 1}`,
      direction: 'inbound',
      sender_handle: { handle: sender, is_me: false },
      parts: [{ type: 'text', value: text }],
      sent_at: clock.toISOString(),
      service: 'iMessage',
    },
  };
}

function door(present: readonly string[] = [MEI, ADA, BOT]) {
  const sends: string[] = [];
  const reads: string[] = [];
  const pages: OpsPage[] = [];
  const outcomes: string[] = [];
  const warned: unknown[] = [];
  let line = 0;
  const reader: SharedGroupReader = {
    async read(input) {
      reads.push(input.text);
      return {
        intent: 'question',
        role: 'unclear',
        familyLabel: null,
        kidName: null,
        confidence: 'high',
      } as Awaited<ReturnType<SharedGroupReader['read']>>;
    },
  };
  const listHandles: ListChatHandles = async () => ({
    status: 'ok',
    handles: [...present],
    isGroup: true,
  });
  const deps = {
    database: db.database,
    intake: () => {
      throw new Error('no 1:1 intake runs in this file');
    },
    enqueue: async () => {
      throw new Error('a shared-group turn queues nothing');
    },
    log: {
      info: () => {},
      warn: (fields: unknown) => {
        warned.push(fields);
      },
      error: () => {},
    },
    countOutcome: async (outcome: string) => {
      outcomes.push(outcome);
    },
    now: () => clock,
    listChatHandles: listHandles,
    sharedGroupReader: reader,
    sharedGroupVoice: fakeSharedGroupComposer({
      body: () => {
        line += 1;
        return `Hale line ${line}`;
      },
    }),
    privateAsideModel: { read: async () => [], draft: async () => null },
    groupLoopGuardPage: async (page: OpsPage) => {
      pages.push(page);
      return 'paged' as const;
    },
    sendGroupText: async (input: { chatId: string; text: string }) => {
      sends.push(input.text);
      return { providerMessageId: `out-${sends.length}` };
    },
  } as unknown as Parameters<typeof handleLinqInboundRequest>[1];
  return { deps, sends, reads, pages, outcomes, warned };
}

async function post(
  deps: Parameters<typeof handleLinqInboundRequest>[1],
  sender: string,
  text: string,
  chatId = CHAT,
): Promise<string> {
  const response = await handleLinqInboundRequest(signed(groupText(sender, text, chatId)), deps);
  expect(response.status).toBe(200);
  return ((await response.json()) as { outcome: string }).outcome;
}

/** The bot repeats Hale's newest line, at once, `turns` times. Returns each door outcome. */
async function echo(
  wire: ReturnType<typeof door>,
  turns: number,
): Promise<{ outcomes: string[]; haleAnswered: number }> {
  const outcomes: string[] = [];
  const before = wire.sends.length;
  for (let turn = 0; turn < turns; turn += 1) {
    tick(1_500);
    outcomes.push(await post(wire.deps, BOT, wire.sends.at(-1) ?? 'hello'));
  }
  return { outcomes, haleAnswered: wire.sends.length - before };
}

async function guardAudits() {
  return db.database
    .select({ familyId: schema.auditLog.familyId, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.actionTaken, 'linq_group_loop_guard_quiet'));
}

describe('an echo bot in a shared group, at the door (VIL-728 acceptance)', () => {
  it('Hale stops after the cap, sends nothing about it, and a person speaking resumes it', async () => {
    const { mei, ada } = await seedSharedChat();
    const wire = door();

    tick();
    expect(await post(wire.deps, MEI, 'Hale, who is bringing snacks on Saturday?')).toBe(
      'shared_reply',
    );
    expect(wire.sends).toEqual(['Hale line 1']);

    const first = await echo(wire, 10);
    expect(first.haleAnswered).toBe(GROUP_LOOP_GUARD_CAP_DEFAULT);
    expect(first.outcomes.slice(0, 5)).toEqual(Array(5).fill('shared_reply'));
    expect(first.outcomes.slice(5)).toEqual(Array(5).fill('group_loop_guard_quiet'));
    // Quiet means quiet: no line about it, and no model read of what the bot said.
    expect(wire.sends).toHaveLength(1 + GROUP_LOOP_GUARD_CAP_DEFAULT);
    expect(wire.reads).toHaveLength(1 + GROUP_LOOP_GUARD_CAP_DEFAULT);
    expect(wire.outcomes.filter((o) => o === 'rate_limited')).toHaveLength(5);

    // The ops event, once: an internal audit row per household and one page, counts only.
    expect(wire.pages).toEqual([{ site: 'group_loop_guard_tripped', facts: {}, count: 5 }]);
    expect((await guardAudits()).map((row) => row.familyId).sort()).toEqual(
      [mei.familyId, ada.familyId].sort(),
    );
    expect(wire.warned).toContainEqual(
      expect.objectContaining({ outcome: 'group_loop_guard_tripped', haleSince: 5, cap: 5 }),
    );

    // A person speaks: Hale answers them, and the bot can be answered again, up to the cap.
    tick(30_000);
    expect(await post(wire.deps, ADA, 'Hale, what time does it start?')).toBe('shared_reply');
    const second = await echo(wire, 8);
    expect(second.haleAnswered).toBe(GROUP_LOOP_GUARD_CAP_DEFAULT);
    expect(second.outcomes.at(-1)).toBe('group_loop_guard_quiet');
    expect(wire.pages).toHaveLength(2);
  });

  it('with the flag off, Hale keeps answering the bot exactly as it does today', async () => {
    vi.stubEnv('GROUP_LOOP_GUARD_ENABLED', '');
    await seedSharedChat();
    const wire = door();

    tick();
    expect(await post(wire.deps, MEI, 'Hale, who is bringing snacks on Saturday?')).toBe(
      'shared_reply',
    );
    const run = await echo(wire, 10);
    expect(run.haleAnswered).toBe(10);
    expect(run.outcomes).toEqual(Array(10).fill('shared_reply'));
    expect(wire.pages).toEqual([]);
    expect(await guardAudits()).toEqual([]);
    expect(await db.database.select().from(schema.linqGroupLoopGuards)).toEqual([]);
  });

  it('a stop from the bot still goes on through a quiet chat', async () => {
    await seedSharedChat();
    const wire = door();
    tick();
    await post(wire.deps, MEI, 'Hale, who is bringing snacks on Saturday?');
    const run = await echo(wire, 6);
    expect(run.outcomes.at(-1)).toBe('group_loop_guard_quiet');

    tick();
    expect(await post(wire.deps, BOT, 'stop')).toBe('member_stopped');
    const [seat] = await db.database
      .select({ stoppedAt: schema.linqSharedGroupPeople.stoppedAt })
      .from(schema.linqSharedGroupPeople)
      .where(eq(schema.linqSharedGroupPeople.phoneE164Hash, phoneBlindIndex(BOT)));
    expect(seat?.stoppedAt).not.toBeNull();
  });
});

describe('people talking with Hale in a shared group', () => {
  it('are never held, flag on, however much Hale says', async () => {
    await seedSharedChat();
    const wire = door();
    for (let i = 0; i < 12; i += 1) {
      tick(20_000);
      expect(await post(wire.deps, i % 2 === 0 ? MEI : ADA, `Hale, question ${i}?`)).toBe(
        'shared_reply',
      );
    }
    expect(wire.sends).toHaveLength(12);
    expect(wire.pages).toEqual([]);
    expect(await db.database.select().from(schema.linqGroupLoopGuards)).toEqual([]);
  });
});

describe('a quiet household group', () => {
  async function seedHousehold() {
    const home = await seedParent(MEI, 'Mei');
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: HOME_CHAT })
      .where(eq(schema.families.id, home.familyId));
    await db.database
      .insert(schema.linqGroupLoopGuards)
      .values({ chatId: HOME_CHAT, runStartedAt: NOW, quietSince: NOW, updatedAt: NOW });
    return home;
  }

  function householdDoor(reading: GroupTurnReading) {
    const wire = door([MEI]);
    const turnReads: string[] = [];
    const reader: GroupTurnReader = {
      async read(input) {
        turnReads.push(input.text);
        return reading;
      },
    };
    const voice = fakeGroupOnboardingComposer();
    const deps = {
      ...wire.deps,
      groupTurnReader: reader,
      groupVoice: voice,
    } as Parameters<typeof handleLinqInboundRequest>[1];
    return { ...wire, deps, turnReads, voice };
  }

  it('holds the bot before the roster, the turn reader or any line, and the parent reopens it', async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
    vi.stubEnv('LINQ_GROUP_TURN_AI_ENABLED', 'true');
    await seedHousehold();
    const wire = householdDoor('chatter');

    tick();
    expect(await post(wire.deps, BOT, 'Hale line 9', HOME_CHAT)).toBe('group_loop_guard_quiet');
    expect(wire.sends).toEqual([]);
    expect(wire.turnReads).toEqual([]);
    expect(wire.voice.calls).toEqual([]);
    expect(wire.pages).toEqual([]);

    tick();
    expect(await post(wire.deps, MEI, 'see you at pickup', HOME_CHAT)).toBe(
      'group_chatter_ignored',
    );
    expect(wire.turnReads).toEqual(['see you at pickup']);
    expect(await db.database.select().from(schema.linqGroupLoopGuards)).toEqual([]);
  });
});
