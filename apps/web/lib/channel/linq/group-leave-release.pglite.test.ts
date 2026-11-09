import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { linqChatBlindIndex } from '~/lib/crypto/blind-index';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { leftChatSince, releaseGroupOnLeave } from './group-leave';

/** VIL-477 Design blocker: an accepted leave releases the claim with onboarding v2 dark. */
const NOW = new Date('2026-10-30T12:00:00.000Z');
const KEY = Buffer.alloc(32, 7).toString('base64');
let db: TestDb;
beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

describe('releaseGroupOnLeave', () => {
  it("clears this family's claim on the chat, writes one audit row, idempotent", async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', '');
    const fam = await seedFamily(db.database);
    const other = await seedFamily(db.database, 'Other');
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: 'chat-left' })
      .where(eq(schema.families.id, fam.familyId));
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: 'chat-other' })
      .where(eq(schema.families.id, other.familyId));

    const first = await releaseGroupOnLeave(db.database, {
      familyId: fam.familyId,
      chatId: 'chat-left',
      askedBy: fam.parentUserId,
      now: NOW,
    });
    expect(first).toEqual({ released: true });
    const rows = await db.database
      .select({ id: schema.families.id, chat: schema.families.linqGroupChatId })
      .from(schema.families);
    expect(rows.find((r) => r.id === fam.familyId)?.chat).toBeNull();
    expect(rows.find((r) => r.id === other.familyId)?.chat).toBe('chat-other');

    const audit = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, fam.familyId));
    const left = audit.filter((a) => a.actionTaken === 'linq_group_left_on_ask');
    // Immutable and in every adult's copy: the chat is named by its key, never its raw id.
    expect(left.map((a) => a.after)).toEqual([
      { claimReleased: true, chatKey: linqChatBlindIndex('chat-left') },
    ]);

    // a wrong-family call cannot release another family's chat
    const wrong = await releaseGroupOnLeave(db.database, {
      familyId: fam.familyId,
      chatId: 'chat-other',
      askedBy: null,
      now: NOW,
    });
    expect(wrong).toEqual({ released: false });
    const otherRow = await db.database
      .select({ chat: schema.families.linqGroupChatId })
      .from(schema.families)
      .where(eq(schema.families.id, other.familyId));
    expect(otherRow[0]?.chat).toBe('chat-other');
  });

  it('gates sends: a turn that arrived before the leave is stopped; one after a re-add is not', async () => {
    const fam = await seedFamily(db.database, 'Gate');
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: 'chat-gate' })
      .where(eq(schema.families.id, fam.familyId));
    const beforeLeave = new Date(Date.now() - 60_000);
    expect(await leftChatSince(db.database, { chatId: 'chat-gate', since: beforeLeave })).toBe(
      false,
    );

    await releaseGroupOnLeave(db.database, {
      familyId: fam.familyId,
      chatId: 'chat-gate',
      askedBy: fam.parentUserId,
      now: NOW,
    });

    expect(await leftChatSince(db.database, { chatId: 'chat-gate', since: beforeLeave })).toBe(
      true,
    );
    // another chat is untouched
    expect(await leftChatSince(db.database, { chatId: 'chat-elsewhere', since: beforeLeave })).toBe(
      false,
    );
    // a leave row written before the key carries the raw chat id, and still gates
    await db.database.insert(schema.auditLog).values({
      familyId: fam.familyId,
      actor: fam.parentUserId,
      actionTaken: 'linq_group_left_on_ask',
      targetTable: 'families',
      targetId: fam.familyId,
      after: { claimReleased: true, chatId: 'chat-legacy' },
    });
    expect(await leftChatSince(db.database, { chatId: 'chat-legacy', since: beforeLeave })).toBe(
      true,
    );
    // a message that arrived after the leave (Hale re-added) is newer than the leave row
    const afterLeave = new Date(Date.now() + 60_000);
    expect(await leftChatSince(db.database, { chatId: 'chat-gate', since: afterLeave })).toBe(
      false,
    );
  });
});
