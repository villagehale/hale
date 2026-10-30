import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendMessage, resolveOrCreateNoteConversation } from '~/lib/coach/conversation';
import { channelGroupNoteKey, channelSmsNoteKey } from '~/lib/coach/note-key';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { RECENT_NOTICES, readRecentNotices } from './recent-notices';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

const pause = () => new Promise((r) => setTimeout(r, 5));

describe('readRecentNotices', () => {
  it('is only this parent’s own 1:1, the newest few, never another chat’s line', async () => {
    const { database } = db;
    const mine = await seedFamily(database, 'Mine');
    const other = await seedFamily(database, 'Other');
    const own = await resolveOrCreateNoteConversation(
      mine.familyId,
      channelSmsNoteKey(mine.parentUserId),
      database,
    );
    const group = await resolveOrCreateNoteConversation(
      mine.familyId,
      channelGroupNoteKey('chat-1'),
      database,
    );
    const otherOwn = await resolveOrCreateNoteConversation(
      other.familyId,
      channelSmsNoteKey(other.parentUserId),
      database,
    );

    for (const line of [
      'Swim is off Saturday.',
      'Picture day is Friday at 9.',
      'Storytime moved to Sunday.',
      'Pottery starts Monday.',
    ]) {
      await appendMessage(own, 'assistant', line, database);
      await pause();
    }
    await appendMessage(own, 'user', 'PARENT wrote this', database);
    await appendMessage(group, 'assistant', 'GROUP confirm', database);
    await appendMessage(otherOwn, 'assistant', 'OTHER FAMILY notice', database);

    const recent = await readRecentNotices(database, mine);
    expect(recent).toEqual([
      'Pottery starts Monday.',
      'Storytime moved to Sunday.',
      'Picture day is Friday at 9.',
    ]);
    expect(recent).toHaveLength(RECENT_NOTICES);
    for (const leak of ['PARENT', 'GROUP', 'OTHER FAMILY'])
      expect(recent.join(' ')).not.toContain(leak);
  });

  it('reads nothing, and creates no thread, for a parent Hale has not texted', async () => {
    const fresh = await seedFamily(db.database, 'Fresh');
    expect(await readRecentNotices(db.database, fresh)).toEqual([]);
  });
});
