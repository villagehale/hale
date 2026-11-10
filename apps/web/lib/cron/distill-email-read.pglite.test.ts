import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDistillTools } from '~/lib/cron/inference-tools';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

/**
 * VIL-616 · a reply the coach wrote after `read_email` may repeat the email's own words:
 * a planted name, a 555 number, a code. The router marks that thread row
 * `{ kind: 'read_email' }`, and the nightly distiller never reads it, so nothing a stranger
 * wrote can become a family fact. The parent's own turns, and Hale's other replies, still
 * reach it.
 */

const NOW = new Date('2026-11-08T15:00:00.000Z');
const PLANTED = 'Call Dale Quill at 555-0147 with code TRIP-88.';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function readWindow(familyId: string): Promise<string[]> {
  const tool = buildDistillTools(db.database, NOW).find(
    (t) => t.name === 'read_recent_conversations',
  );
  if (!tool) throw new Error('no read_recent_conversations tool');
  const { turns } = (await tool.handler({}, { familyId, actor: 'system' })) as {
    turns: { role: string; content: string }[];
  };
  return turns.map((turn) => `${turn.role}: ${turn.content}`);
}

describe('the distiller never reads a reply written after read_email', () => {
  it('leaves the marked row out, and keeps every other turn', async () => {
    const { familyId } = await seedFamily(db.database);
    const [conversation] = await db.database
      .insert(schema.conversations)
      .values({ familyId })
      .returning({ id: schema.conversations.id });
    const conversationId = conversation?.id as string;
    const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);
    await db.database.insert(schema.messages).values([
      { conversationId, role: 'user', content: 'what did the school email say?', createdAt: at(4) },
      {
        conversationId,
        role: 'assistant',
        content: `The trip is Friday. ${PLANTED}`,
        source: { kind: 'read_email' },
        createdAt: at(3),
      },
      { conversationId, role: 'user', content: 'Wren naps at 1pm every day.', createdAt: at(2) },
      { conversationId, role: 'assistant', content: 'Got it, 1pm naps.', createdAt: at(1) },
    ]);

    const window = await readWindow(familyId);

    expect(window.join('\n')).not.toContain('555-0147');
    expect(window.join('\n')).not.toContain('Dale Quill');
    // Positive control: the parent's turns and Hale's ordinary reply still reach it.
    expect(window).toEqual([
      'assistant: Got it, 1pm naps.',
      'user: Wren naps at 1pm every day.',
      'user: what did the school email say?',
    ]);
  });
});
