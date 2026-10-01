import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildDistillTools, buildInferenceTools } from '~/lib/cron/inference-tools';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

/**
 * The 2026-10-01 incident, through the tool the distiller actually calls.
 * Intake's suggestion list is an assistant turn. The model then asks to save
 * `children_age_range` "based on enrollment". With no booking and no family
 * event, that write must not land, and the refusal must be logged without
 * copying the class names into the log.
 */

const NOW = new Date('2026-10-01T10:43:00.000Z');
const SUGGESTION_LIST = [
  '1. Tiny Dancers (2-4 years) - Oct 3',
  '2. Parent & Tot Swimming (18 months-3 years) - Oct 3',
].join('\n');
const PARENT_INTAKE = 'Maya is 3 and Leo is 1. We are in Burlington.';
const INCIDENT_SUMMARY =
  'Children are 2-4 based on enrollment in Tiny Dancers and Parent & Tot Swimming starting Oct 3';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function seedThread(
  familyId: string,
  turns: { role: 'user' | 'assistant'; content: string }[],
) {
  const [conversation] = await db.database
    .insert(schema.conversations)
    .values({ familyId })
    .returning({ id: schema.conversations.id });
  const conversationId = conversation?.id;
  if (!conversationId) throw new Error('conversation insert returned no id');
  await db.database.insert(schema.messages).values(
    turns.map((turn, index) => ({
      conversationId,
      role: turn.role,
      content: turn.content,
      createdAt: new Date(NOW.getTime() - (turns.length - index) * 60_000),
    })),
  );
}

function saveChild(database: TestDb['database']) {
  const tool = buildDistillTools(database, NOW).find((t) => t.name === 'save_child_fact');
  if (!tool) throw new Error('no save_child_fact tool');
  return tool;
}

async function seedBooking(
  familyId: string,
  parentUserId: string,
  title: string,
  cancelledAt: Date | null,
) {
  const [message] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'email_alert',
      templateKey: 'connector:email_alert',
      status: 'sent',
      sentAt: NOW,
    })
    .returning({ id: schema.channelMessages.id });
  if (!message) throw new Error('channel message insert returned no id');
  await db.database.insert(schema.activityBookings).values({
    familyId,
    parentUserId,
    integrationId: randomUUID(),
    messageId: randomUUID(),
    providerHost: 'recreation.example.ca',
    title,
    firstSessionAt: new Date('2026-10-03T14:00:00.000Z'),
    channelMessageId: message.id,
    cancelledAt,
  });
}

async function liveFacts(familyId: string) {
  return db.database
    .select()
    .from(schema.familyMemoryFacts)
    .where(eq(schema.familyMemoryFacts.familyId, familyId));
}

describe('save_child_fact refuses a suggestion list stored as enrollment', () => {
  it('does not write the 2026-10-01 children_age_range fact, and logs the refusal without the class names', async () => {
    const { familyId } = await seedFamily(db.database);
    await seedThread(familyId, [
      { role: 'user', content: PARENT_INTAKE },
      { role: 'assistant', content: SUGGESTION_LIST },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await saveChild(db.database).handler(
      {
        category: 'development',
        factKey: 'children_age_range',
        summary: INCIDENT_SUMMARY,
        confidence: 0.95,
      },
      { familyId, actor: 'system' },
    );

    expect(result).toEqual({ saved: false, reason: 'ungrounded_enrollment' });
    expect(await liveFacts(familyId)).toEqual([]);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('children_age_range');
    expect(logged).toContain('ungrounded_enrollment');
    expect(logged).not.toContain('Tiny Dancers');
    expect(logged).not.toContain('based on enrollment');
    warn.mockRestore();
  });

  it('still writes a routine the parent stated in the same thread', async () => {
    const { familyId } = await seedFamily(db.database);
    await seedThread(familyId, [
      { role: 'user', content: 'Maya naps at 1 these days' },
      { role: 'assistant', content: SUGGESTION_LIST },
    ]);

    const result = await saveChild(db.database).handler(
      {
        childId: null,
        category: 'routines',
        factKey: 'naps',
        summary: 'Maya naps at 1',
        confidence: 0.9,
      },
      { familyId, actor: 'system' },
    );

    expect(result).toMatchObject({ saved: true });
    const [fact] = await liveFacts(familyId);
    expect(fact?.factKey).toBe('naps');
    expect(fact?.factValue).toMatchObject({ summary: 'Maya naps at 1' });
  });

  it('keeps the parent sentence and drops the unbooked class from a mixed summary', async () => {
    const { familyId } = await seedFamily(db.database);
    await seedThread(familyId, [
      { role: 'user', content: 'Maya naps at 1' },
      { role: 'assistant', content: SUGGESTION_LIST },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await saveChild(db.database).handler(
      {
        category: 'routines',
        factKey: 'naps',
        summary: 'Maya naps at 1. She is enrolled in Tiny Dancers.',
        confidence: 0.9,
      },
      { familyId, actor: 'system' },
    );

    expect(result).toMatchObject({ saved: true });
    const [fact] = await liveFacts(familyId);
    expect(fact?.factValue).toMatchObject({ summary: 'Maya naps at 1.' });
    expect(JSON.stringify(fact?.factValue)).not.toMatch(/enrolled/i);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('allows enrollment wording when a live family event names that class', async () => {
    const { familyId } = await seedFamily(db.database);
    await seedThread(familyId, [
      { role: 'user', content: PARENT_INTAKE },
      { role: 'assistant', content: SUGGESTION_LIST },
    ]);
    await db.database.insert(schema.familyEvents).values({
      familyId,
      title: 'Tiny Dancers',
      startsAt: new Date('2026-10-03T14:00:00.000Z'),
      source: 'parent',
    });

    const result = await saveChild(db.database).handler(
      {
        category: 'preferences',
        factKey: 'dance_class',
        summary: 'Enrolled in Tiny Dancers',
        confidence: 0.9,
      },
      { familyId, actor: 'system' },
    );

    expect(result).toMatchObject({ saved: true });
    const [fact] = await liveFacts(familyId);
    expect(fact?.factValue).toMatchObject({ summary: 'Enrolled in Tiny Dancers' });
  });

  it('allows enrollment wording when a live activity booking names that class', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await seedThread(familyId, [
      { role: 'user', content: PARENT_INTAKE },
      { role: 'assistant', content: SUGGESTION_LIST },
    ]);
    await seedBooking(familyId, parentUserId, 'Tiny Dancers', null);

    const result = await saveChild(db.database).handler(
      {
        category: 'preferences',
        factKey: 'dance_class',
        summary: 'Enrolled in Tiny Dancers',
        confidence: 0.9,
      },
      { familyId, actor: 'system' },
    );

    expect(result).toMatchObject({ saved: true });
    const [fact] = await liveFacts(familyId);
    expect(fact?.factValue).toMatchObject({ summary: 'Enrolled in Tiny Dancers' });
  });

  it('does not treat a cancelled booking as backing', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await seedThread(familyId, [
      { role: 'user', content: PARENT_INTAKE },
      { role: 'assistant', content: SUGGESTION_LIST },
    ]);
    await seedBooking(familyId, parentUserId, 'Tiny Dancers', NOW);

    const result = await saveChild(db.database).handler(
      {
        category: 'preferences',
        factKey: 'dance_class',
        summary: 'Enrolled in Tiny Dancers',
        confidence: 0.9,
      },
      { familyId, actor: 'system' },
    );

    expect(result).toEqual({ saved: false, reason: 'ungrounded_enrollment' });
    expect(await liveFacts(familyId)).toEqual([]);
  });

  it('refuses the same claim when the model routes it through save_memory', async () => {
    const { familyId } = await seedFamily(db.database);
    await seedThread(familyId, [
      { role: 'user', content: PARENT_INTAKE },
      { role: 'assistant', content: SUGGESTION_LIST },
    ]);
    const save = buildInferenceTools(db.database, NOW).find((t) => t.name === 'save_memory');
    if (!save) throw new Error('no save_memory tool');

    const result = await save.handler(
      {
        factType: 'relationship',
        factKey: 'children_age_range',
        factValue: { summary: INCIDENT_SUMMARY },
        confidence: 0.95,
      },
      { familyId, actor: 'system' },
    );

    expect(result).toEqual({ saved: false, reason: 'ungrounded_enrollment' });
    expect(await liveFacts(familyId)).toEqual([]);
  });
});
