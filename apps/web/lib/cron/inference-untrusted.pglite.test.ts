import { markUntrusted } from '@hale/agent';
import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildInferenceTools } from '~/lib/cron/inference-tools';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

const NOW = new Date('2026-11-08T06:00:00.000Z');
const PAYLOAD = { subject: 'Picture day', detail: { note: 'Bring a smile' }, count: 2 };

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

async function seedRow(familyId: string, source: string, hoursAgo: number, childId?: string) {
  const [row] = await db.database
    .insert(schema.events)
    .values({
      familyId,
      source,
      childId: childId ?? null,
      eventType: 'school_communication',
      payload: PAYLOAD,
      dedupHash: `${familyId}-${source}-${hoursAgo}`,
      receivedAt: new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000),
    })
    .returning({ id: schema.events.id });
  if (!row) throw new Error('event insert returned no row');
  return row.id;
}

async function snapshotPayloads(familyId: string) {
  const tool = buildInferenceTools(db.database, NOW).find((t) => t.name === 'read_recent_memory');
  if (!tool) throw new Error('no read_recent_memory tool');
  const snapshot = (await tool.handler({}, { familyId, actor: 'system' })) as {
    recentEvents: { eventId: string | null; payload: unknown }[];
  };
  return snapshot.recentEvents;
}

function markedAs(label: 'email' | 'calendar' | 'other') {
  return {
    subject: markUntrusted(label, 'subject', 'Picture day'),
    detail: { note: markUntrusted(label, 'note', 'Bring a smile') },
    count: 2,
  };
}

describe('read_recent_memory marks event payloads by where each row came from (VIL-560)', () => {
  it('flag on: gmail is email, gcal is calendar, a text is other', async () => {
    vi.stubEnv('UNTRUSTED_FIELD_MARKING_ENABLED', 'true');
    const { familyId } = await seedFamily(db.database);
    const gmail = await seedRow(familyId, 'gmail', 3);
    const gcal = await seedRow(familyId, 'gcal', 2);
    const sms = await seedRow(familyId, 'channel_sms', 1);

    const events = await snapshotPayloads(familyId);

    expect(events.find((e) => e.eventId === gmail)?.payload).toEqual(markedAs('email'));
    expect(events.find((e) => e.eventId === gcal)?.payload).toEqual(markedAs('calendar'));
    expect(events.find((e) => e.eventId === sms)?.payload).toEqual(markedAs('other'));
  });

  it('flag on: a teen row keeps its placeholder, with no mark around it', async () => {
    vi.stubEnv('UNTRUSTED_FIELD_MARKING_ENABLED', 'true');
    const { familyId } = await seedFamily(db.database);
    const [teen] = await db.database
      .insert(schema.children)
      .values({ familyId, name: 'Rowan', dateOfBirth: '2010-01-01' })
      .returning({ id: schema.children.id });
    await seedRow(familyId, 'gmail', 2, teen?.id);
    const adult = await seedRow(familyId, 'gmail', 1);

    const events = await snapshotPayloads(familyId);

    const withheld = events.find((e) => e.eventId === null);
    expect(typeof withheld?.payload).toBe('string');
    expect(String(withheld?.payload)).not.toContain('<untrusted');
    expect(events.find((e) => e.eventId === adult)?.payload).toEqual(markedAs('email'));
  });

  it('flag off: every payload is the stored row, unmarked', async () => {
    vi.stubEnv('UNTRUSTED_FIELD_MARKING_ENABLED', '');
    const { familyId } = await seedFamily(db.database);
    const gcal = await seedRow(familyId, 'gcal', 1);

    const events = await snapshotPayloads(familyId);

    expect(events.find((e) => e.eventId === gcal)?.payload).toEqual(PAYLOAD);
  });
});
