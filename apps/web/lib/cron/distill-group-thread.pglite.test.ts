import { schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendMessage } from '~/lib/coach/conversation';
import { channelGroupNoteKey, channelSmsNoteKey } from '~/lib/coach/note-key';
import { buildDistillTools } from '~/lib/cron/inference-tools';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

/**
 * VIL-597 (G8) · the nightly distiller learns "what the parent said", and its skill reads
 * every `user` turn as the parent. A group thread holds every seated member's texts: a
 * caregiver, a grandparent, a parent from another family, and Hale answering any of them.
 * Only a turn a parent of THIS family wrote may reach the distiller from a group thread.
 * The 1:1 thread is the parent's own, and reads as before.
 */

const NOW = new Date('2026-11-08T15:00:00.000Z');
const CHAT = 'chat-family-group';

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

async function member(familyId: string, role: string): Promise<string> {
  const [user] = await db.database
    .insert(schema.users)
    .values({ email: `${role}-${familyId}@example.test`, name: 'Member' })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('no user');
  await db.database.execute(
    sql`insert into family_members (family_id, user_id, role) values (${familyId}, ${user.id}, ${role})`,
  );
  return user.id;
}

async function thread(familyId: string, noteKey: string): Promise<string> {
  const [row] = await db.database
    .insert(schema.conversations)
    .values({ familyId, noteKey })
    .returning({ id: schema.conversations.id });
  if (!row) throw new Error('no conversation');
  return row.id;
}

/** Each turn a minute after the last, so the window's newest-first order is fixed. */
let minute = 30;
async function say(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  authorUserId: string | null,
): Promise<void> {
  const id = await appendMessage(conversationId, role, content, db.database, {
    childId: null,
    topic: null,
    ...(authorUserId ? { authorUserId } : {}),
  });
  minute -= 1;
  await db.database.execute(
    sql`update messages set created_at = ${new Date(NOW.getTime() - minute * 60_000).toISOString()} where id = ${id}`,
  );
}

describe('the distiller reads a group thread as the parents said it, and nothing else', () => {
  it("takes a parent's group words, never a caregiver's, another family's, an unsigned turn or Hale's group reply", async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Home');
    const coParentId = await member(familyId, 'co_parent');
    const nannyId = await member(familyId, 'nanny');
    const grandparentId = await member(familyId, 'grandparent');
    const other = await seedFamily(db.database, 'Neighbours');

    const direct = await thread(familyId, channelSmsNoteKey(parentUserId));
    await say(direct, 'user', 'Wren naps at 1pm every day.', parentUserId);
    await say(direct, 'assistant', 'Got it, 1pm naps.', null);

    const group = await thread(familyId, channelGroupNoteKey(CHAT));
    await say(group, 'user', 'Wren starts swim on Tuesdays.', coParentId);
    await say(group, 'user', 'Wren is allergic to peanuts.', nannyId);
    await say(group, 'user', 'Wren goes to bed at 9 at my place.', grandparentId);
    await say(group, 'user', 'Our Juno has a heart condition.', other.parentUserId);
    await say(group, 'user', 'Wren hates the bath.', null);
    await say(group, 'assistant', 'Noted: peanuts are out, and Juno is resting.', null);

    const window = await readWindow(familyId);

    const seen = window.join('\n');
    expect(seen).not.toContain('peanuts');
    expect(seen).not.toContain('bed at 9');
    expect(seen).not.toContain('Juno');
    expect(seen).not.toContain('bath');
    // Positive control: the co-parent's group words and the whole 1:1 thread still reach it.
    expect(window).toEqual([
      'user: Wren starts swim on Tuesdays.',
      'assistant: Got it, 1pm naps.',
      'user: Wren naps at 1pm every day.',
    ]);
  });

  it("never reads another family's thread for the same group chat", async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Shared A');
    const other = await seedFamily(db.database, 'Shared B');

    const mine = await thread(familyId, channelGroupNoteKey('chat-shared'));
    await say(mine, 'user', 'Ivy loves the climbing gym.', parentUserId);
    const theirs = await thread(other.familyId, channelGroupNoteKey('chat-shared'));
    await say(theirs, 'user', 'Our Juno is in hospital this week.', other.parentUserId);

    expect(await readWindow(familyId)).toEqual(['user: Ivy loves the climbing gym.']);
    expect(await readWindow(other.familyId)).toEqual(['user: Our Juno is in hospital this week.']);
  });
});
