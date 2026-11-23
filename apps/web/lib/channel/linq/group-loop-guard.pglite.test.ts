import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import type { OpsPage } from '~/lib/monitoring/failure-page';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  GROUP_LOOP_GUARD_CAP,
  GROUP_LOOP_GUARD_RUN_GAP_MS,
  type GroupLoopGuardVerdict,
  checkGroupLoopGuard,
  checkGroupLoopGuardSignal,
  isSeatedInChat,
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
const OTHER_PARENT = '+14165550177';
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
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table linq_group_loop_guards, linq_shared_group_people, linq_multi_family_members, linq_group_members, linq_group_rosters, audit_log, channel_messages, families, users cascade',
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

function guard(
  senderHandle: string,
  at: Date = clock,
  chatId: string = CHAT,
): Promise<GroupLoopGuardVerdict> {
  return checkGroupLoopGuard(db.database, { chatId, senderHandle, at });
}

async function holdsChat(owner: { familyId: string }, chatId: string = CHAT): Promise<void> {
  await db.database
    .update(schema.families)
    .set({ linqGroupChatId: chatId })
    .where(eq(schema.families.id, owner.familyId));
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

describe('who counts as a person', () => {
  it('is a parent or co-parent of the family that holds this chat', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await seedParent(TOM, 'Tom', { familyId: mei.familyId });
    await holdsChat(mei);
    expect(await isSeatedInChat(db.database, CHAT, MEI)).toBe(true);
    expect(await isSeatedInChat(db.database, CHAT, TOM)).toBe(true);
    expect(await isSeatedInChat(db.database, 'chat-elsewhere', MEI)).toBe(false);
  });

  it('is a live household seat, and not one that was removed', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    const ada = await seedParent(ADA, 'Ada');
    const [seat] = await db.database
      .insert(schema.linqGroupMembers)
      .values({
        familyId: mei.familyId,
        chatId: CHAT,
        userId: ada.userId,
        phoneE164Encrypted: encryptString(ADA),
        phoneE164Hash: phoneBlindIndex(ADA),
        role: 'caregiver',
      })
      .returning({ id: schema.linqGroupMembers.id });
    expect(await isSeatedInChat(db.database, CHAT, ADA)).toBe(true);
    await db.database
      .update(schema.linqGroupMembers)
      .set({ removedAt: NOW })
      .where(eq(schema.linqGroupMembers.id, seat?.id as string));
    expect(await isSeatedInChat(db.database, CHAT, ADA)).toBe(false);
  });

  it('is a known family placed in a shared chat, and never a stranger placed there', async () => {
    const ada = await seedParent(ADA, 'Ada');
    await db.database.insert(schema.linqSharedGroupPeople).values([
      {
        chatId: CHAT,
        phoneE164Encrypted: encryptString(ADA),
        phoneE164Hash: phoneBlindIndex(ADA),
        familyId: ada.familyId,
        userId: ada.userId,
      },
      {
        chatId: CHAT,
        phoneE164Encrypted: encryptString(BOT),
        phoneE164Hash: phoneBlindIndex(BOT),
      },
    ]);
    expect(await isSeatedInChat(db.database, CHAT, ADA)).toBe(true);
    expect(await isSeatedInChat(db.database, CHAT, BOT)).toBe(false);
  });

  it('is never an Apple ID email, Hale’s own line, or a number nobody knows', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    for (const handle of ['someone@example.com', HALE, BOT]) {
      expect(await isSeatedInChat(db.database, CHAT, handle)).toBe(false);
    }
  });

  it('a verified Hale parent of another family, not seated here, cannot reopen a quiet chat', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    await seedParent(OTHER_PARENT, 'Other');
    const run = await echoBot(mei, GROUP_LOOP_GUARD_CAP + 1);
    expect(run.verdicts.at(-1)?.verdict).toBe('quiet');

    tick();
    const verdict = await guard(OTHER_PARENT);
    expect(verdict.verdict).toBe('quiet');
    expect(await guardRows()).toHaveLength(1);
  });
});

describe('with GROUP_LOOP_GUARD_ENABLED off', () => {
  it('reads and writes nothing, for anything but exactly true', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    for (const value of ['', 'false', '1', 'TRUE', 'yes']) {
      vi.stubEnv('GROUP_LOOP_GUARD_ENABLED', value);
      expect(await guard(BOT)).toEqual({ verdict: 'off' });
      expect(
        await checkGroupLoopGuardSignal(db.database, {
          chatId: CHAT,
          senderHandle: BOT,
          at: clock,
        }),
      ).toEqual({ verdict: 'off' });
    }
    expect(await guardRows()).toEqual([]);
  });
});

describe('an echo bot in a family group (VIL-728 acceptance)', () => {
  it('Hale stops at the cap, and a seated person speaking resumes it', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);

    const first = await echoBot(mei, 12);
    expect(first.haleAnswered).toBe(GROUP_LOOP_GUARD_CAP);
    expect(first.verdicts.slice(0, GROUP_LOOP_GUARD_CAP).map((v) => v.verdict)).toEqual(
      Array(GROUP_LOOP_GUARD_CAP).fill('open'),
    );
    expect(first.verdicts[GROUP_LOOP_GUARD_CAP]).toEqual({
      verdict: 'quiet',
      tripped: true,
      haleSince: GROUP_LOOP_GUARD_CAP,
      cap: GROUP_LOOP_GUARD_CAP,
    });
    expect(first.verdicts.slice(GROUP_LOOP_GUARD_CAP + 1).map((v) => v.verdict)).toEqual(
      Array(12 - GROUP_LOOP_GUARD_CAP - 1).fill('quiet'),
    );

    tick();
    expect(await guard(MEI)).toEqual({ verdict: 'person', resumed: true });
    expect(await guardRows()).toEqual([]);

    const second = await echoBot(mei, GROUP_LOOP_GUARD_CAP + 2);
    expect(second.haleAnswered).toBe(GROUP_LOOP_GUARD_CAP);
  });

  it('still stops a slow bot that answers every few minutes', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    let haleAnswered = 0;
    let last: GroupLoopGuardVerdict = { verdict: 'off' };
    for (let turn = 0; turn < GROUP_LOOP_GUARD_CAP + 3; turn += 1) {
      tick(8 * 60_000);
      last = await guard(BOT);
      if (last.verdict !== 'open') break;
      tick(1_000);
      await haleSays(mei);
      haleAnswered += 1;
    }
    expect(haleAnswered).toBe(GROUP_LOOP_GUARD_CAP);
    expect(last.verdict).toBe('quiet');
  });
});

describe('two people talking with Hale in a busy group', () => {
  it('are never held, however much Hale says', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await seedParent(TOM, 'Tom', { familyId: mei.familyId });
    await holdsChat(mei);
    for (let turn = 0; turn < 20; turn += 1) {
      tick(15_000);
      const verdict = await guard(turn % 2 === 0 ? MEI : TOM);
      expect(verdict).toEqual({ verdict: 'person', resumed: false });
      await haleSays(mei);
    }
    expect(await guardRows()).toEqual([]);
  });
});

describe('what counts toward the cap', () => {
  it('only Hale messages since the run opened: reminders before it do not count', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    for (let i = 0; i < GROUP_LOOP_GUARD_CAP + 2; i += 1) await haleSays(mei);
    tick();
    expect(await guard(BOT)).toEqual({
      verdict: 'open',
      haleSince: 0,
      cap: GROUP_LOOP_GUARD_CAP,
    });
  });

  it('a long gap between unseated turns ends the run, so a slow day never adds up', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    expect((await guard(BOT)).verdict).toBe('open');
    for (let i = 0; i < GROUP_LOOP_GUARD_CAP; i += 1) {
      tick();
      await haleSays(mei);
    }
    tick(GROUP_LOOP_GUARD_RUN_GAP_MS + 1_000);
    expect(await guard(BOT)).toEqual({
      verdict: 'open',
      haleSince: 0,
      cap: GROUP_LOOP_GUARD_CAP,
    });
  });

  it('a gap does not reopen a chat that already went quiet', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    const run = await echoBot(mei, GROUP_LOOP_GUARD_CAP + 1);
    expect(run.verdicts.at(-1)?.verdict).toBe('quiet');
    tick(GROUP_LOOP_GUARD_RUN_GAP_MS * 3);
    expect((await guard(BOT)).verdict).toBe('quiet');
  });

  it('not a failed send, a reaction, an edit, another chat, a covered row, or a second row', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    expect((await guard(BOT)).verdict).toBe('open');
    tick();
    await haleSays(mei, { status: 'failed' });
    await haleSays(mei, { templateKey: 'linq:tapback' });
    await haleSays(mei, { templateKey: 'linq:edit' });
    await haleSays(mei, { providerChatId: 'chat-another' });
    await haleSays(mei, { errorCode: 'covered_by_combined_notice' });
    await haleSays(mei, { providerMessageId: 'shared-bubble' });
    await haleSays(mei, { providerMessageId: 'shared-bubble' });
    tick();
    expect(await guard(BOT)).toEqual({ verdict: 'open', haleSince: 1, cap: GROUP_LOOP_GUARD_CAP });
  });
});

describe('redelivery and isolation', () => {
  it('a redelivered message from a seated person does not reopen a quiet chat', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    const spokeAt = clock;
    expect((await guard(MEI, spokeAt)).verdict).toBe('person');
    tick(60_000);
    const run = await echoBot(mei, GROUP_LOOP_GUARD_CAP + 1);
    expect(run.verdicts.at(-1)?.verdict).toBe('quiet');

    tick();
    expect(await guard(MEI, spokeAt)).toEqual({ verdict: 'person', resumed: false });
    expect((await guard(BOT)).verdict).toBe('quiet');
  });

  it('a redelivered bot message does not count twice', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    tick();
    const sentAt = clock;
    expect(await guard(BOT, sentAt)).toEqual({
      verdict: 'open',
      haleSince: 0,
      cap: GROUP_LOOP_GUARD_CAP,
    });
    tick();
    await haleSays(mei);
    tick();
    for (let delivery = 0; delivery < 3; delivery += 1) {
      expect(await guard(BOT, sentAt)).toEqual({
        verdict: 'open',
        haleSince: 1,
        cap: GROUP_LOOP_GUARD_CAP,
      });
    }
  });

  it('one chat going quiet never touches another family’s chat', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    const ada = await seedParent(ADA, 'Ada');
    await holdsChat(ada, 'chat-other-family');
    const run = await echoBot(mei, GROUP_LOOP_GUARD_CAP + 1);
    expect(run.verdicts.at(-1)?.verdict).toBe('quiet');

    tick();
    expect(await guard(BOT, clock, 'chat-other-family')).toEqual({
      verdict: 'open',
      haleSince: 0,
      cap: GROUP_LOOP_GUARD_CAP,
    });
  });
});

describe('tapbacks and poll votes', () => {
  function signal(senderHandle: string, chatId: string = CHAT) {
    return checkGroupLoopGuardSignal(db.database, { chatId, senderHandle, at: clock });
  }

  it('an unseated reaction opens a run in a household group and trips at the cap', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    expect(await signal(BOT)).toEqual({ verdict: 'open', haleSince: 0, cap: GROUP_LOOP_GUARD_CAP });
    for (let i = 0; i < GROUP_LOOP_GUARD_CAP; i += 1) {
      tick();
      await haleSays(mei);
    }
    tick();
    expect(await signal(BOT)).toEqual({
      verdict: 'quiet',
      tripped: true,
      haleSince: GROUP_LOOP_GUARD_CAP,
      cap: GROUP_LOOP_GUARD_CAP,
    });
  });

  it('never guards a 1:1 chat, however much Hale has said there', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    for (let i = 0; i < GROUP_LOOP_GUARD_CAP + 2; i += 1) {
      await haleSays(mei, { providerChatId: 'chat-one-to-one' });
    }
    tick();
    expect(await signal(MEI, 'chat-one-to-one')).toEqual({ verdict: 'not_group' });
    expect(await guardRows()).toEqual([]);
  });

  it('a seated person’s tapback neither is held nor reopens a quiet chat', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    await echoBot(mei, GROUP_LOOP_GUARD_CAP + 1);

    tick();
    expect(await signal(MEI)).toEqual({ verdict: 'person', resumed: false });
    expect((await guard(BOT)).verdict).toBe('quiet');
  });
});

describe('the trip', () => {
  it('takes the chat quiet exactly once when bot messages race', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    expect((await guard(BOT)).verdict).toBe('open');
    for (let i = 0; i < GROUP_LOOP_GUARD_CAP; i += 1) {
      tick();
      await haleSays(mei);
    }
    tick();
    const verdicts = await Promise.all([guard(BOT), guard(BOT), guard(BOT), guard(BOT)]);
    expect(verdicts.map((v) => v.verdict)).toEqual(Array(4).fill('quiet'));
    expect(verdicts.filter((v) => v.verdict === 'quiet' && v.tripped)).toHaveLength(1);
  });

  it('audits every household in the chat and pages #ops once, with counts only', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    const ada = await seedParent(ADA, 'Ada');
    await db.database.insert(schema.linqSharedGroupPeople).values({
      chatId: CHAT,
      phoneE164Encrypted: encryptString(ADA),
      phoneE164Hash: phoneBlindIndex(ADA),
      familyId: ada.familyId,
      userId: ada.userId,
    });
    const pages: OpsPage[] = [];
    const trip = await noteGroupLoopGuardTrip(
      db.database,
      { chatId: CHAT, haleSince: GROUP_LOOP_GUARD_CAP, cap: GROUP_LOOP_GUARD_CAP },
      {
        page: async (page) => {
          pages.push(page);
          return 'paged';
        },
      },
    );
    expect(trip).toEqual({ audited: 2, auditFailed: false, page: 'paged' });
    expect(pages).toEqual([
      { site: 'group_loop_guard_tripped', facts: {}, count: GROUP_LOOP_GUARD_CAP },
    ]);
    const audits = await db.database
      .select({ familyId: schema.auditLog.familyId, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_loop_guard_quiet'));
    expect(audits.map((row) => row.familyId).sort()).toEqual([mei.familyId, ada.familyId].sort());
    for (const row of audits) {
      expect(row.after).toEqual({ haleSince: GROUP_LOOP_GUARD_CAP, cap: GROUP_LOOP_GUARD_CAP });
    }
    expect(JSON.stringify(pages)).not.toContain(CHAT);
  });

  it('names a page that throws, and the chat stays quiet', async () => {
    const mei = await seedParent(MEI, 'Mei');
    await holdsChat(mei);
    await echoBot(mei, GROUP_LOOP_GUARD_CAP + 1);
    const trip = await noteGroupLoopGuardTrip(
      db.database,
      { chatId: CHAT, haleSince: GROUP_LOOP_GUARD_CAP, cap: GROUP_LOOP_GUARD_CAP },
      {
        page: async () => {
          throw new Error('slack is down');
        },
      },
    );
    expect(trip.page).toBe('page_threw');
    tick();
    expect((await guard(BOT)).verdict).toBe('quiet');
  });
});
