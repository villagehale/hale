import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import type { OpsPage } from '~/lib/monitoring/failure-page';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  GROUP_LOOP_GUARD_CAP_DEFAULT,
  GROUP_LOOP_GUARD_WINDOW_MS,
  type GroupLoopGuardVerdict,
  checkGroupLoopGuard,
  groupLoopGuardCap,
  groupSpeakerOf,
  noteGroupLoopGuardTrip,
} from './group-loop-guard';

/**
 * VIL-728 · the loop guard against the real migrated schema. Hale's "replies" here are the
 * outbound ledger rows every group send writes; the guard reads only who spoke and how much
 * Hale said, so no model and no message text is involved anywhere in this file.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const HALE = '+14165550100';
const MEI = '+14165550111';
const TOM = '+14165550112';
const ADA = '+14165550121';
const BOT = '+14165550199';
const NEWCOMER = '+14165550188';
const CHAT = 'chat-loop-guard';
const NOW = new Date('2026-11-20T15:00:00.000Z');

let db: TestDb;
let clock = NOW;
let haleSeq = 0;

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
  vi.stubEnv('GROUP_LOOP_GUARD_ENABLED', 'true');
  vi.stubEnv('GROUP_LOOP_GUARD_CAP', '');
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table linq_group_loop_guards, linq_shared_group_people, linq_group_rosters, audit_log, channel_messages, families, users cascade',
  );
});

function tick(ms = 3_000): Date {
  clock = new Date(clock.getTime() + ms);
  vi.setSystemTime(clock);
  return clock;
}

async function seedParent(
  phone: string,
  name: string,
  options: { familyId?: string; revoked?: boolean } = {},
): Promise<{ familyId: string; userId: string }> {
  let familyId = options.familyId;
  if (!familyId) {
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: name, provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    familyId = family?.id as string;
  }
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}`, name })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId,
    userId,
    role: options.familyId ? 'co_parent' : 'primary_parent',
  });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
    ...(options.revoked ? { revokedAt: NOW } : {}),
  });
  return { familyId, userId };
}

/** One Hale text into the chat, ledgered the way the group send paths ledger theirs. */
async function haleSays(
  owner: { familyId: string; userId: string },
  extra: Partial<typeof schema.channelMessages.$inferInsert> = {},
): Promise<void> {
  haleSeq += 1;
  await db.database.insert(schema.channelMessages).values({
    familyId: owner.familyId,
    parentUserId: owner.userId,
    channel: 'imessage',
    direction: 'out',
    category: 'reply',
    templateKey: 'linq:test_line',
    providerMessageId: `hale-${haleSeq}`,
    providerChatId: CHAT,
    status: 'sent',
    sentAt: clock,
    ...extra,
  });
}

function guard(senderHandle: string): Promise<GroupLoopGuardVerdict> {
  return checkGroupLoopGuard(db.database, { chatId: CHAT, senderHandle, now: clock });
}

async function guardRows() {
  return db.database.select().from(schema.linqGroupLoopGuards);
}

/**
 * The echo bot: it answers every Hale line, at once, and Hale answers every bot line the
 * guard lets through. Returns how many times Hale answered and what the guard said.
 */
async function echoBot(
  owner: { familyId: string; userId: string },
  botTurns: number,
): Promise<{ haleAnswered: number; verdicts: GroupLoopGuardVerdict[] }> {
  let haleAnswered = 0;
  const verdicts: GroupLoopGuardVerdict[] = [];
  for (let turn = 0; turn < botTurns; turn += 1) {
    tick(1_000);
    const verdict = await guard(BOT);
    verdicts.push(verdict);
    if (verdict.verdict !== 'open') continue;
    tick();
    await haleSays(owner);
    haleAnswered += 1;
  }
  return { haleAnswered, verdicts };
}

describe('groupLoopGuardCap', () => {
  it('is the default when unset or blank', () => {
    expect(groupLoopGuardCap({})).toBe(GROUP_LOOP_GUARD_CAP_DEFAULT);
    expect(groupLoopGuardCap({ GROUP_LOOP_GUARD_CAP: '' })).toBe(GROUP_LOOP_GUARD_CAP_DEFAULT);
    expect(groupLoopGuardCap({ GROUP_LOOP_GUARD_CAP: '  ' })).toBe(GROUP_LOOP_GUARD_CAP_DEFAULT);
    expect(GROUP_LOOP_GUARD_CAP_DEFAULT).toBe(5);
  });

  it('takes a whole number from 1 to 50', () => {
    expect(groupLoopGuardCap({ GROUP_LOOP_GUARD_CAP: '1' })).toBe(1);
    expect(groupLoopGuardCap({ GROUP_LOOP_GUARD_CAP: '7' })).toBe(7);
    expect(groupLoopGuardCap({ GROUP_LOOP_GUARD_CAP: ' 7\n' })).toBe(7);
    expect(groupLoopGuardCap({ GROUP_LOOP_GUARD_CAP: '50' })).toBe(50);
  });

  it('is the default for anything else', () => {
    for (const raw of ['0', '51', '-3', '5.5', '05', '1e1', '0x10', 'five']) {
      expect(groupLoopGuardCap({ GROUP_LOOP_GUARD_CAP: raw })).toBe(GROUP_LOOP_GUARD_CAP_DEFAULT);
    }
  });
});

describe('groupSpeakerOf', () => {
  it('is a person for a verified Hale channel', async () => {
    await seedParent(MEI, 'Mei');
    expect(await groupSpeakerOf(db.database, MEI)).toBe('person');
  });

  it('is unverified for an unknown number, an Apple ID email, and Hale’s own line', async () => {
    await seedParent(MEI, 'Mei');
    expect(await groupSpeakerOf(db.database, BOT)).toBe('unverified');
    expect(await groupSpeakerOf(db.database, 'helper@example.com')).toBe('unverified');
    expect(await groupSpeakerOf(db.database, HALE)).toBe('unverified');
  });

  it('is unverified for a revoked channel, the predicate the household door answers by', async () => {
    await seedParent(MEI, 'Mei', { revoked: true });
    expect(await groupSpeakerOf(db.database, MEI)).toBe('unverified');
  });
});

describe('with GROUP_LOOP_GUARD_ENABLED off', () => {
  it('reads and writes nothing, for anything but exactly true', async () => {
    const owner = await seedParent(MEI, 'Mei');
    for (let i = 0; i < 8; i += 1) await haleSays(owner);
    for (const value of ['', 'false', 'TRUE', 'true\n', '1', 'on']) {
      vi.stubEnv('GROUP_LOOP_GUARD_ENABLED', value);
      expect(await guard(BOT)).toEqual({ verdict: 'off' });
      expect(await guard(MEI)).toEqual({ verdict: 'off' });
    }
    expect(await guardRows()).toEqual([]);
  });
});

describe('an echo bot in a family group (VIL-728 acceptance)', () => {
  it('Hale stops after the cap, and a person speaking resumes it', async () => {
    const owner = await seedParent(MEI, 'Mei');

    // A parent asks; Hale answers.
    tick();
    expect(await guard(MEI)).toEqual({ verdict: 'person', resumed: false });
    tick();
    await haleSays(owner);

    const first = await echoBot(owner, 12);
    expect(first.haleAnswered).toBe(GROUP_LOOP_GUARD_CAP_DEFAULT);
    expect(first.verdicts.slice(0, 5).map((v) => v.verdict)).toEqual([
      'open',
      'open',
      'open',
      'open',
      'open',
    ]);
    expect(first.verdicts[5]).toEqual({ verdict: 'quiet', tripped: true, haleSince: 5, cap: 5 });
    // Every later bot line is quiet, and only one message ever took the chat quiet.
    expect(first.verdicts.slice(6)).toEqual(
      Array(6).fill({ verdict: 'quiet', tripped: false, haleSince: null, cap: 5 }),
    );

    // Silence holds for as long as only the bot talks, well past the counting window.
    tick(GROUP_LOOP_GUARD_WINDOW_MS * 4);
    expect((await echoBot(owner, 3)).haleAnswered).toBe(0);

    // A person speaks: the chat reopens and the run is gone.
    tick(20_000);
    expect(await guard(MEI)).toEqual({ verdict: 'person', resumed: true });
    expect(await guardRows()).toEqual([]);
    tick();
    await haleSays(owner);

    // The bot gets the cap again, and no more.
    const second = await echoBot(owner, 9);
    expect(second.haleAnswered).toBe(GROUP_LOOP_GUARD_CAP_DEFAULT);
    expect(second.verdicts.filter((v) => v.verdict === 'quiet' && v.tripped)).toHaveLength(1);
  });

  it('honours GROUP_LOOP_GUARD_CAP', async () => {
    vi.stubEnv('GROUP_LOOP_GUARD_CAP', '2');
    const owner = await seedParent(MEI, 'Mei');
    const run = await echoBot(owner, 6);
    expect(run.haleAnswered).toBe(2);
    expect(run.verdicts[2]).toEqual({ verdict: 'quiet', tripped: true, haleSince: 2, cap: 2 });
  });
});

describe('a group of people', () => {
  it('is never held, however much Hale says', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await seedParent(TOM, 'Tom', { familyId: mei.familyId });
    await seedParent(ADA, 'Ada');
    for (let i = 0; i < 30; i += 1) {
      tick();
      expect(await guard([MEI, TOM, ADA][i % 3] as string)).toEqual({
        verdict: 'person',
        resumed: false,
      });
      // Two bubbles a reply, far past the cap over the conversation.
      tick();
      await haleSays(mei);
      await haleSays(mei);
    }
    expect(await guardRows()).toEqual([]);
  });

  it('lets a newcomer be asked who they are after a busy morning of Hale replies', async () => {
    const mei = await seedParent(MEI, 'Mei');
    for (let i = 0; i < 4; i += 1) {
      tick();
      await guard(MEI);
      tick();
      await haleSays(mei);
      await haleSays(mei);
      await haleSays(mei);
    }
    // Twelve Hale messages, all answers to a person: none of them is the newcomer's run.
    tick();
    expect(await guard(NEWCOMER)).toEqual({ verdict: 'open', haleSince: 0, cap: 5 });
  });
});

describe('what counts toward the cap', () => {
  it('only Hale messages since the run opened: reminders before it do not count', async () => {
    const owner = await seedParent(MEI, 'Mei');
    for (let i = 0; i < 8; i += 1) {
      tick(60_000);
      await haleSays(owner, { category: 'reminder', templateKey: 'linq:test_reminder' });
    }
    tick();
    expect(await guard(NEWCOMER)).toEqual({ verdict: 'open', haleSince: 0, cap: 5 });
  });

  it('only the last 30 minutes of a run', async () => {
    const owner = await seedParent(MEI, 'Mei');
    tick();
    expect((await guard(BOT)).verdict).toBe('open');
    for (let i = 0; i < 4; i += 1) {
      tick();
      await haleSays(owner);
    }
    tick(GROUP_LOOP_GUARD_WINDOW_MS + 60_000);
    expect(await guard(BOT)).toEqual({ verdict: 'open', haleSince: 0, cap: 5 });
  });

  it('not a failed send, a reaction, an edit, another chat, a covered row, or a second row', async () => {
    const owner = await seedParent(MEI, 'Mei');
    tick();
    expect((await guard(BOT)).verdict).toBe('open');
    tick();
    await haleSays(owner, { status: 'failed' });
    await haleSays(owner, { status: 'suppressed_quiet_hours' });
    await haleSays(owner, { templateKey: 'linq:tapback' });
    await haleSays(owner, { templateKey: 'linq:sticker' });
    await haleSays(owner, { templateKey: 'linq:edit' });
    await haleSays(owner, { templateKey: 'linq:duty_tapback' });
    await haleSays(owner, { providerChatId: 'chat-somewhere-else' });
    await haleSays(owner, { errorCode: 'covered_by_combined_notice' });
    await haleSays(owner, { direction: 'in' });
    await haleSays(owner, { providerMessageId: null, status: 'queued', sentAt: null });
    // Counted: one message ledgered twice, and a claimed line still in flight.
    await haleSays(owner, { providerMessageId: 'one-message' });
    await haleSays(owner, { providerMessageId: 'one-message', templateKey: null });
    await haleSays(owner, { providerMessageId: null });
    tick();
    expect(await guard(BOT)).toEqual({ verdict: 'open', haleSince: 2, cap: 5 });
  });
});

describe('the trip', () => {
  it('takes the chat quiet exactly once when bot messages race', async () => {
    const owner = await seedParent(MEI, 'Mei');
    tick();
    await guard(BOT);
    for (let i = 0; i < 5; i += 1) {
      tick();
      await haleSays(owner);
    }
    tick();
    const raced = await Promise.all([guard(BOT), guard(BOT), guard(BOT)]);
    expect(raced.every((v) => v.verdict === 'quiet')).toBe(true);
    expect(raced.filter((v) => v.verdict === 'quiet' && v.tripped)).toHaveLength(1);
  });

  it('audits every household in the chat and pages #ops once, with counts only', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: CHAT })
      .where(eq(schema.families.id, mei.familyId));
    const ada = await seedParent(ADA, 'Ada');
    await db.database.insert(schema.linqSharedGroupPeople).values({
      chatId: CHAT,
      phoneE164Hash: phoneBlindIndex(ADA),
      familyId: ada.familyId,
      userId: ada.userId,
    });
    const pages: OpsPage[] = [];
    const trip = await noteGroupLoopGuardTrip(
      db.database,
      { chatId: CHAT, haleSince: 5, cap: 5 },
      {
        page: async (page) => {
          pages.push(page);
          return 'paged';
        },
      },
    );
    expect(trip).toEqual({ audited: 2, auditFailed: false, page: 'paged' });
    expect(pages).toEqual([{ site: 'group_loop_guard_tripped', facts: {}, count: 5 }]);

    const rows = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_loop_guard_quiet'));
    expect(rows.map((row) => row.familyId).sort()).toEqual([mei.familyId, ada.familyId].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        actor: 'system',
        targetTable: 'linq_group_loop_guards',
        targetId: CHAT,
        after: { haleSince: 5, cap: 5 },
      });
    }
    const written = JSON.stringify(rows);
    for (const phone of [MEI, ADA, BOT]) expect(written).not.toContain(phone);
  });

  it('a chat no household has claimed audits nobody and still pages', async () => {
    const trip = await noteGroupLoopGuardTrip(
      db.database,
      { chatId: CHAT, haleSince: 5, cap: 5 },
      { page: async () => 'paged' },
    );
    expect(trip).toEqual({ audited: 0, auditFailed: false, page: 'paged' });
  });

  it('names a page that throws, and the chat stays quiet', async () => {
    const owner = await seedParent(MEI, 'Mei');
    const run = await echoBot(owner, 6);
    expect(run.verdicts[5]).toMatchObject({ verdict: 'quiet', tripped: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const trip = await noteGroupLoopGuardTrip(
      db.database,
      { chatId: CHAT, haleSince: 5, cap: 5 },
      {
        page: async () => {
          throw new Error('slack down');
        },
      },
    );
    error.mockRestore();
    expect(trip.page).toBe('page_threw');
    tick();
    expect(await guard(BOT)).toEqual({ verdict: 'quiet', tripped: false, haleSince: null, cap: 5 });
  });
});
