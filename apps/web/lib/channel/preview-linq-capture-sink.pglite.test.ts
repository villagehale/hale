import { schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  type CapturedLinqCall,
  PreviewGroupCaptureRefused,
  databaseGroupCaptureSink,
} from './preview-linq-capture';

const CHAT = 'preview-chat-household-1';
const FAKE_A = '+14375550101';
const FAKE_B = '+14375550102';
const REAL = '+14165550123';

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

async function rowCount(): Promise<number> {
  const [row] = await t.database
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.previewCapturedLinqCalls);
  return Number(row?.n ?? 0);
}

function call(over: Partial<CapturedLinqCall> = {}): CapturedLinqCall {
  return {
    chatId: CHAT,
    kind: 'message',
    method: 'POST',
    path: `/chats/${CHAT}/messages`,
    body: { message: { parts: [{ type: 'text', value: 'See you at 4' }] } },
    handles: null,
    providerMessageId: 'preview-gcapture-1',
    ...over,
  };
}

describe('databaseGroupCaptureSink.record refuses anything real and stores nothing', () => {
  it('stores a fake chat with fake handles', async () => {
    await databaseGroupCaptureSink(t.database).record(
      call({ kind: 'chat_create', handles: [FAKE_A, FAKE_B], body: { to: [FAKE_A, FAKE_B] } }),
    );
    expect(await rowCount()).toBe(1);
  });

  it.each([
    ['a real chat id', call({ chatId: 'chat_8f2a1c' })],
    ['a real handle in handles', call({ kind: 'chat_create', handles: [FAKE_A, REAL] })],
    ['a real handle in body.to', call({ kind: 'chat_create', body: { to: [FAKE_A, REAL] } })],
    ['a real sender in a roster body', call({ kind: 'roster', body: { from: REAL, text: 'hi' } })],
    [
      'a real participant handle in the body',
      call({ kind: 'participant_add', body: { handle: REAL } }),
    ],
    [
      'a real handle nested in participants',
      call({ kind: 'participant_add', body: { participants: [{ handle: REAL }] } }),
    ],
  ])('throws on %s', async (_label, bad) => {
    const before = await rowCount();
    await expect(databaseGroupCaptureSink(t.database).record(bad)).rejects.toBeInstanceOf(
      PreviewGroupCaptureRefused,
    );
    expect(await rowCount()).toBe(before);
  });
});
