import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { postMailNoticeToHouseholdGroup } from './mail-notice';
import { fakeGroupExperienceComposer } from './voice-fake';

/**
 * VIL-399 scene 07: a provider moved swim from 3pm to 4pm (Toronto). The model is handed
 * the household's own clock, never a bare UTC instant it would have to convert.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-11-11T16:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('GROUP_MAIL_NOTICE_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

it('writes the moved time in the household clock', async () => {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ada', provinceOrState: 'ON', linqGroupChatId: 'chat-household' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'imessage:ada', name: 'Ada' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: user?.id as string, role: 'primary_parent' });
  const [event] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId,
      title: 'swim',
      startsAt: new Date('2026-11-14T21:00:00.000Z'),
      source: 'parent',
    })
    .returning({ id: schema.familyEvents.id });
  const composer = fakeGroupExperienceComposer();
  await postMailNoticeToHouseholdGroup(db.database, {
    familyId,
    eventId: event?.id as string,
    change: { field: 'time', previousStartsAt: new Date('2026-11-14T20:00:00.000Z') },
    timeZone: 'America/Toronto',
    now: NOW,
    composer,
    send: async () => ({ providerMessageId: 'out-1' }),
  });
  const facts = composer.calls[0]?.input.facts;
  expect(facts).toMatchObject({ title: 'swim', field: 'time' });
  expect(String(facts?.when)).toContain('4:00 PM');
  expect(String(facts?.previousWhen)).toContain('3:00 PM');
  expect(JSON.stringify(facts)).not.toContain('T21:00');
});

describe('only a time or date move posts', () => {
  it('a venue change is not a time notice', async () => {
    const composer = fakeGroupExperienceComposer();
    const out = await postMailNoticeToHouseholdGroup(db.database, {
      familyId: '00000000-0000-4000-8000-000000000000',
      eventId: '00000000-0000-4000-8000-000000000001',
      change: { field: 'venue', previousLocation: 'old pool' },
      timeZone: 'America/Toronto',
      now: NOW,
      composer,
    });
    expect(out).toBe('skipped');
    expect(composer.calls).toEqual([]);
  });
});
