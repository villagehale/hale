import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { releaseGroupOnLeave } from './group-leave';

/** VIL-477 Design blocker: an accepted leave releases the claim with onboarding v2 dark. */
const NOW = new Date('2026-10-30T12:00:00.000Z');
let db: TestDb;
beforeAll(async () => {
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
    expect(audit.filter((a) => a.actionTaken === 'linq_group_left_on_ask')).toHaveLength(1);

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
});
