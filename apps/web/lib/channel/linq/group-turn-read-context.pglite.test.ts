import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appendMessage, resolveOrCreateNoteConversation } from '~/lib/coach/conversation';
import { channelGroupNoteKey, channelSmsNoteKey } from '~/lib/coach/note-key';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { groupTurnReadContext } from './group-turn-reader';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

async function seed() {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Dong', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'imessage:barton', name: 'Barton Dong' })
    .returning({ id: schema.users.id });
  return { familyId: family?.id as string, userId: user?.id as string };
}

describe('VIL-440 group turn read context', () => {
  it('passes the sender first name and only this group thread, never a 1:1 thread', async () => {
    const { familyId, userId } = await seed();
    const group = await resolveOrCreateNoteConversation(
      familyId,
      channelGroupNoteKey('chat-g'),
      db.database,
    );
    const oneToOne = await resolveOrCreateNoteConversation(
      familyId,
      channelSmsNoteKey(userId),
      db.database,
    );
    await appendMessage(oneToOne, 'user', 'PRIVATE: the therapist moved to Thursday', db.database);
    await appendMessage(
      group,
      'assistant',
      'Which day works for swim, Tuesday or Wednesday?',
      db.database,
    );
    await appendMessage(group, 'user', 'Tuesday works', db.database);

    const context = await groupTurnReadContext(db.database, {
      familyId,
      chatId: 'chat-g',
      senderUserId: userId,
    });
    expect(context.senderName).toBe('Barton');
    expect(context.recent).toEqual([
      { from: 'hale', text: 'Which day works for swim, Tuesday or Wednesday?' },
      { from: 'member', text: 'Tuesday works' },
    ]);
    expect(JSON.stringify(context)).not.toContain('PRIVATE');
  });

  it('keeps only the last six group lines', async () => {
    const { familyId, userId } = await seed();
    const group = await resolveOrCreateNoteConversation(
      familyId,
      channelGroupNoteKey('chat-g'),
      db.database,
    );
    for (let i = 0; i < 9; i += 1) await appendMessage(group, 'user', `line ${i}`, db.database);
    const context = await groupTurnReadContext(db.database, {
      familyId,
      chatId: 'chat-g',
      senderUserId: userId,
    });
    expect(context.recent.map((line) => line.text)).toEqual([
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
      'line 8',
    ]);
  });

  it('an unknown sender or unclaimed group gets no name and no history', async () => {
    expect(
      await groupTurnReadContext(db.database, {
        familyId: null,
        chatId: 'chat-x',
        senderUserId: null,
      }),
    ).toEqual({ senderName: null, recent: [] });
  });
});
