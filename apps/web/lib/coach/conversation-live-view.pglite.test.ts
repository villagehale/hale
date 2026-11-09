import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendMessage,
  loadTranscript,
  resolveOrCreateNoteConversation,
} from '~/lib/coach/conversation';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

// Anyone holding a Browser Use live-view link drives a browser holding the parent's
// provider session and cart. The thread is re-read by every later coach turn and kept
// after that browser is gone, so the link must never be stored in it.
const TOKEN = 'fixture-live-view-token';
const LIVE = `https://live.browser-use.com/s/${TOKEN}`;
const REC = 'https://register.example-rec.test/activity/42';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

describe('conversation history and the live-view link', () => {
  it('stores a delivered live-view reply without the link, and keeps a registration link', async () => {
    const { database } = db;
    const family = await seedFamily(database, 'LiveView');
    const thread = await resolveOrCreateNoteConversation(
      family.familyId,
      channelSmsNoteKey(family.parentUserId),
      database,
    );

    await appendMessage(
      thread,
      'assistant',
      `I got to the payment step. Pay in the open browser within 12 minutes: ${LIVE}`,
      database,
    );
    await appendMessage(thread, 'user', `is this the right one? ${LIVE}`, database);
    await appendMessage(thread, 'assistant', `Sign up on their page: ${REC}`, database);

    const transcript = await loadTranscript(thread, database);
    const stored = await database
      .select({ content: schema.messages.content })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, thread));
    for (const text of [JSON.stringify(transcript), JSON.stringify(stored)]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('live.browser-use.com');
    }
    expect(transcript).toHaveLength(3);
    expect(transcript[0]?.content).toContain('Pay in the open browser within 12 minutes');
    expect(transcript[2]?.content).toBe(`Sign up on their page: ${REC}`);
  });
});
