import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { createPostgresGroupExperienceStore } from './store';

const CHAT = 'chat-experience-store';
const NOW = new Date('2026-11-11T16:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  await db.exec('truncate table families cascade');
});

describe('linq_group_experience store', () => {
  it('keeps one live row per chat/kind/subject and closes it in place', async () => {
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Patel', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    const familyId = family?.id as string;
    const store = createPostgresGroupExperienceStore(db.database);
    const live = await store.upsertLive({
      chatId: CHAT,
      familyId,
      kind: 'rsvp_poll',
      subjectKey: 'plan-1',
      payload: { planId: 'plan-1' },
      now: NOW,
    });
    const again = await store.loadLive(CHAT, 'rsvp_poll');
    expect(again?.id).toBe(live.id);
    await store.close(live.id, new Date('2026-11-11T17:00:00.000Z'));
    expect(await store.loadLive(CHAT, 'rsvp_poll')).toBeNull();
  });
});
