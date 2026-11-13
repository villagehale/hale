import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOpenCommitmentById } from '~/lib/commitments/ledger';
import { type SeededFamily, type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { defaultActivityPromisePorts, recordActivityPromise } from './commitment';
import { resolveFollowUpRecipient } from './sweep';

/**
 * THE THREAD A KEPT PROMISE IS ANSWERED IN, read off the production resolver against the
 * real DDL. While `deep-followup-now` is lit for the family, a thread is returned only for
 * a promise carried on iMessage, and it is the PARENT'S ASK it threads under — the inbound
 * the promise answered, as every reply does — never Hale's own reply. The ask must be one
 * the door saw as 1:1. Anything it cannot vouch for is no thread, and today's routing.
 * Dark, there is never a thread: the answer is routed as it was before the flag existed.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The promise as the ledger holds it: whose family, the message that carried it, and the
 * language the screen read off the ask (null when it read none). */
function owed(seeded: SeededFamily, createdFrom: string, askLanguage: string | null = null) {
  return { familyId: seeded.familyId, createdFrom, askLanguage };
}

let seq = 0;

async function carrying(
  seeded: SeededFamily,
  over: Partial<typeof schema.channelMessages.$inferInsert> = {},
): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      status: 'sent',
      providerChatId: 'chat-one',
      providerMessageId: 'msg-carried',
      sentAt: new Date(),
      ...over,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('channel_messages insert returned no row');
  return row.id;
}

async function inbound(
  seeded: SeededFamily,
  chatId: string,
  inGroup: boolean | null,
  at: Date,
  providerMessageId: string | null = `msg-in-${++seq}`,
): Promise<string | null> {
  await db.database.insert(schema.channelMessages).values({
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    channel: 'imessage',
    direction: 'in',
    category: 'reply',
    status: 'delivered',
    providerChatId: chatId,
    providerMessageId,
    inGroup,
    createdAt: at,
  });
  return providerMessageId;
}

const EARLIER = new Date('2026-11-10T15:00:00.000Z');
const BETWEEN = new Date('2026-11-10T15:30:00.000Z');
const LATER = new Date('2026-11-10T16:00:00.000Z');

describe('resolveFollowUpRecipient: the thread, lit', () => {
  beforeEach(() => {
    vi.stubEnv('DEEP_FOLLOWUP_NOW_ENABLED', 'true');
  });

  it("an iMessage promise made in a 1:1 is answered under the parent's ask, not Hale's reply", async () => {
    const seeded = await seedFamily(db.database);
    const ask = await inbound(seeded, 'chat-one', false, EARLIER);
    const recipient = await resolveFollowUpRecipient(
      db.database,
      owed(seeded, await carrying(seeded)),
    );
    expect(recipient?.thread).toEqual({ chatId: 'chat-one', messageId: ask });
    expect(recipient?.thread?.messageId).not.toBe('msg-carried');
  });

  it('a text the parent sent after the promise was made is not the ask', async () => {
    const seeded = await seedFamily(db.database);
    const ask = await inbound(seeded, 'chat-one', false, EARLIER);
    const promise = await carrying(seeded, { createdAt: BETWEEN });
    await inbound(seeded, 'chat-one', false, LATER);
    const recipient = await resolveFollowUpRecipient(db.database, owed(seeded, promise));
    expect(recipient?.thread).toEqual({ chatId: 'chat-one', messageId: ask });
  });

  it('a promise carried by SMS has no thread', async () => {
    const seeded = await seedFamily(db.database);
    await inbound(seeded, 'chat-one', false, EARLIER);
    const recipient = await resolveFollowUpRecipient(
      db.database,
      owed(seeded, await carrying(seeded, { channel: 'sms', providerChatId: null })),
    );
    expect(recipient).not.toBeNull();
    expect(recipient?.thread).toBeNull();
  });

  it('a chat whose latest inbound came from a group has no thread', async () => {
    const seeded = await seedFamily(db.database);
    await inbound(seeded, 'chat-one', false, EARLIER);
    await inbound(seeded, 'chat-one', true, LATER);
    const recipient = await resolveFollowUpRecipient(
      db.database,
      owed(seeded, await carrying(seeded)),
    );
    expect(recipient?.thread).toBeNull();
  });

  it('a chat the door never said was 1:1 has no thread (fail closed)', async () => {
    const seeded = await seedFamily(db.database);
    await inbound(seeded, 'chat-one', null, EARLIER);
    // A 1:1 inbound in ANOTHER chat says nothing about this one.
    await inbound(seeded, 'chat-elsewhere', false, LATER);
    const recipient = await resolveFollowUpRecipient(
      db.database,
      owed(seeded, await carrying(seeded)),
    );
    expect(recipient).not.toBeNull();
    expect(recipient?.thread).toBeNull();
  });

  it('an ask with no provider message id has no thread to reply under', async () => {
    const seeded = await seedFamily(db.database);
    await inbound(seeded, 'chat-one', false, EARLIER, null);
    const recipient = await resolveFollowUpRecipient(
      db.database,
      owed(seeded, await carrying(seeded)),
    );
    expect(recipient).not.toBeNull();
    expect(recipient?.thread).toBeNull();
  });

  it("Hale's own reply having no provider id does not matter: the thread is the ask's", async () => {
    const seeded = await seedFamily(db.database);
    const ask = await inbound(seeded, 'chat-one', false, EARLIER);
    const recipient = await resolveFollowUpRecipient(
      db.database,
      owed(seeded, await carrying(seeded, { providerMessageId: null })),
    );
    expect(recipient?.thread).toEqual({ chatId: 'chat-one', messageId: ask });
  });
});

/**
 * DARK, THE ANSWER GOES WHERE IT WENT BEFORE THE FLAG. Hand-derived from the resolver
 * before the flag existed: it returned no thread at all, so `deliverFollowUp` sent no
 * `replyIn` and `deliverFamilyOutbound` picked the target itself — the household group when
 * one is claimed, otherwise the parent's own number, unthreaded. The positive control is
 * the first lit case above: the same ask, in the same 1:1 chat, does get a thread there.
 */
describe('resolveFollowUpRecipient: the thread, dark', () => {
  it('a promise made in a 1:1 iMessage chat has no thread', async () => {
    vi.stubEnv('DEEP_FOLLOWUP_NOW_ENABLED', 'false');
    const seeded = await seedFamily(db.database);
    await inbound(seeded, 'chat-one', false, EARLIER);
    const recipient = await resolveFollowUpRecipient(
      db.database,
      owed(seeded, await carrying(seeded)),
    );
    expect(recipient).not.toBeNull();
    expect(recipient?.thread).toBeNull();
  });

  it('the family on the retired allowlist does not relight it once it is set to false', async () => {
    vi.stubEnv('DEEP_FOLLOWUP_NOW_ENABLED', 'false');
    const seeded = await seedFamily(db.database);
    vi.stubEnv('DEEP_FOLLOWUP_NOW_FAMILY_ALLOWLIST', seeded.familyId);
    await inbound(seeded, 'chat-one', false, EARLIER);
    const recipient = await resolveFollowUpRecipient(
      db.database,
      owed(seeded, await carrying(seeded)),
    );
    expect(recipient?.thread).toBeNull();
  });

  it('unset is lit: the same ask gets its thread', async () => {
    vi.stubEnv('DEEP_FOLLOWUP_NOW_ENABLED', undefined);
    const seeded = await seedFamily(db.database);
    const ask = await inbound(seeded, 'chat-one', false, EARLIER);
    const recipient = await resolveFollowUpRecipient(
      db.database,
      owed(seeded, await carrying(seeded)),
    );
    expect(recipient?.thread).toEqual({ chatId: 'chat-one', messageId: ask });
  });
});

describe('resolveFollowUpRecipient: the language', () => {
  async function multilingual(): Promise<SeededFamily> {
    const seeded = await seedFamily(db.database);
    await db.database
      .update(schema.families)
      .set({ primaryLanguage: 'fr' })
      .where(eq(schema.families.id, seeded.familyId));
    await db.database
      .update(schema.users)
      .set({ proactiveLanguage: 'es' })
      .where(eq(schema.users.id, seeded.parentUserId));
    return seeded;
  }

  it("lit: the follow-up is written in the language of the parent's ask", async () => {
    vi.stubEnv('DEEP_FOLLOWUP_NOW_ENABLED', 'true');
    const seeded = await multilingual();
    const recipient = await resolveFollowUpRecipient(
      db.database,
      owed(seeded, await carrying(seeded), 'zh'),
    );
    expect(recipient?.language).toBe('zh');
  });

  it("lit, and the screen read no language off the ask: the parent's stored language", async () => {
    vi.stubEnv('DEEP_FOLLOWUP_NOW_ENABLED', 'true');
    const seeded = await multilingual();
    const recipient = await resolveFollowUpRecipient(
      db.database,
      owed(seeded, await carrying(seeded), null),
    );
    expect(recipient?.language).toBe('es');
  });

  it("lit, and the stored tag is not a language tag: the parent's stored language", async () => {
    vi.stubEnv('DEEP_FOLLOWUP_NOW_ENABLED', 'true');
    const seeded = await multilingual();
    const recipient = await resolveFollowUpRecipient(
      db.database,
      owed(seeded, await carrying(seeded), 'write to me in chinese'),
    );
    expect(recipient?.language).toBe('es');
  });

  it('lit, end to end: the tag the router records on the promise is the language the job reads', async () => {
    vi.stubEnv('DEEP_FOLLOWUP_NOW_ENABLED', 'true');
    const seeded = await multilingual();
    const recorded = await recordActivityPromise(
      db.database,
      {
        familyId: seeded.familyId,
        promise: { subject: 'indoor swim lessons', childId: null },
        channelMessageId: await carrying(seeded),
        askLanguage: 'zh',
        now: EARLIER,
      },
      defaultActivityPromisePorts(),
    );
    if (recorded.status !== 'recorded') throw new Error(`not recorded: ${recorded.reason}`);
    const open = await loadOpenCommitmentById(db.database, recorded.commitmentId);
    if (!open) throw new Error('the recorded promise is not open');

    const recipient = await resolveFollowUpRecipient(db.database, open);

    expect(open.askLanguage).toBe('zh');
    expect(recipient?.language).toBe('zh');
  });

  // Hand-derived from the resolver before the flag: VIL-572's one proactive language,
  // `parentLanguage(users.proactive_language, families.primary_language)`, whatever the
  // ask was written in.
  it("dark: the parent's stored language, whatever the ask was written in", async () => {
    vi.stubEnv('DEEP_FOLLOWUP_NOW_ENABLED', 'false');
    const seeded = await multilingual();
    const recipient = await resolveFollowUpRecipient(
      db.database,
      owed(seeded, await carrying(seeded), 'zh'),
    );
    expect(recipient?.language).toBe('es');
  });
});
