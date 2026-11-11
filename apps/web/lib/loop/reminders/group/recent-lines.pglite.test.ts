import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendMessage, resolveOrCreateNoteConversation } from '~/lib/coach/conversation';
import { channelGroupNoteKey, channelSmsNoteKey } from '~/lib/coach/note-key';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { confirmFacts, readRecentGroupLines } from './facts';

/**
 * A confirm's writer sees what Hale already said in THAT group chat, and nothing else:
 * never another group's confirms, never a parent's private 1:1, never another family.
 */
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

describe('readRecentGroupLines', () => {
  it('hands the writer only this chat’s newest few lines, never another chat’s', async () => {
    const { database } = db;
    const family = await seedFamily(database, 'Lines Family');
    const other = await seedFamily(database, 'Other Family');
    const here = await resolveOrCreateNoteConversation(
      family.familyId,
      channelGroupNoteKey('chat-here'),
      database,
    );
    const elsewhere = await resolveOrCreateNoteConversation(
      family.familyId,
      channelGroupNoteKey('chat-elsewhere'),
      database,
    );
    const privately = await resolveOrCreateNoteConversation(
      family.familyId,
      channelSmsNoteKey(family.parentUserId),
      database,
    );
    const otherFamily = await resolveOrCreateNoteConversation(
      other.familyId,
      channelGroupNoteKey('chat-here'),
      database,
    );

    for (const [i, line] of ['HERE one', 'HERE two', 'HERE three', 'HERE four'].entries()) {
      await appendMessage(here, 'user', `ask ${i}`, database);
      await appendMessage(here, 'assistant', line, database);
      await new Promise((r) => setTimeout(r, 5));
    }
    await appendMessage(elsewhere, 'assistant', 'ELSEWHERE confirm', database);
    await appendMessage(privately, 'assistant', 'PRIVATE reminder', database);
    await appendMessage(otherFamily, 'assistant', 'OTHER FAMILY confirm', database);

    const lines = await readRecentGroupLines(database, {
      familyId: family.familyId,
      chatId: 'chat-here',
    });
    expect(lines).toEqual(['HERE four', 'HERE three', 'HERE two']);

    const facts = confirmFacts({
      language: 'en',
      asker: 'Sam',
      memberWords: 'remind me at 5',
      now: new Date('2026-10-28T12:00:00Z'),
      timeZone: 'America/Toronto',
      plan: { set: [], needsTime: [], notSet: [] },
      cancelled: [],
      recentFromYou: lines,
    });
    const seen = JSON.stringify(facts);
    for (const leak of ['ELSEWHERE', 'PRIVATE', 'OTHER FAMILY', 'ask '])
      expect(seen).not.toContain(leak);
  });

  it('reads nothing, and creates no thread, for a chat Hale has not spoken in', async () => {
    const { familyId } = await seedFamily(db.database, 'Quiet Family');
    expect(await readRecentGroupLines(db.database, { familyId, chatId: 'chat-new' })).toEqual([]);
  });
});
