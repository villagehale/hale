import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canaryChannel } from '~/lib/channel/canary/config';
import { seedCanaryHousehold } from '~/lib/channel/canary/seed';
import { failurePageOpsPager } from '~/lib/monitoring/failure-page';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { pageUnansweredParentTexts } from './unanswered';

/**
 * A real parent's text that the router never finished with pages #ops, over the real DDL
 * and the real pager: only the Slack post is faked. "Finished with" is read from what the
 * router writes: an answered, unanswered or failed ledger row, or the answer claim it
 * takes at its one exit. A claim the text's own burst took by folding it into itself
 * (the 2026-11-12 footprint) is not an exit.
 */

const KEY = Buffer.alloc(32, 5).toString('base64');
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date('2026-11-12T15:20:00.000Z');

let db: TestDb;
let posted: string[];
let parent: { familyId: string; parentUserId: string };

const post = async (text: string) => {
  posted.push(text);
  return 'sent' as const;
};

function tick(now: Date = NOW) {
  return pageUnansweredParentTexts(
    db.database,
    failurePageOpsPager(() => db.database, { post, now }),
    now,
  );
}

let sid = 0;
async function text(
  from: { familyId: string; parentUserId: string },
  minutesAgo: number,
  options: { inGroup?: boolean | null; category?: 'reply' | 'intake'; now?: Date } = {},
): Promise<string> {
  const at = new Date((options.now ?? NOW).getTime() - minutesAgo * MIN);
  sid += 1;
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: from.familyId,
      parentUserId: from.parentUserId,
      channel: 'imessage',
      direction: 'in',
      category: options.category ?? 'reply',
      providerMessageId: `test-inbound-${sid}`,
      status: 'delivered',
      inGroup: options.inGroup === undefined ? false : options.inGroup,
      createdAt: at,
      sentAt: at,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('inbound insert returned no row');
  return row.id;
}

async function ledger(
  channelMessageId: string,
  actionTaken: string,
  after: Record<string, unknown> | null = null,
): Promise<void> {
  await db.database.insert(schema.auditLog).values({
    familyId: parent.familyId,
    actor: parent.parentUserId,
    actionTaken,
    targetTable: 'channel_messages',
    targetId: channelMessageId,
    after,
  });
}

async function claim(channelMessageId: string): Promise<void> {
  await db.database.insert(schema.channelTurnAnswerClaims).values({ channelMessageId });
}

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  posted = [];
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  parent = await seedFamily(db.database, 'Real parent');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.exec(
    'truncate table rate_limits, channel_turn_answer_claims, audit_log, channel_messages, parent_channels, family_members, families, users cascade',
  );
});

describe('pageUnansweredParentTexts', () => {
  it('a real parent text with no claim fifteen minutes on pages #ops once, by site and count', async () => {
    await text(parent, 16);
    // Positive control for the threshold: a text inside its fifteen minutes is not counted.
    await text(parent, 14);

    await expect(tick()).resolves.toEqual({ unanswered: 1, page: 'paged' });
    expect(posted).toEqual(['Hale: ops page. site parent_text_unanswered. count 1.']);
  });

  it('a second unanswered text in the same hour does not page again; the next hour does', async () => {
    await text(parent, 16);
    await expect(tick()).resolves.toEqual({ unanswered: 1, page: 'paged' });

    const later = new Date(NOW.getTime() + 5 * MIN);
    await text(parent, 16, { now: later });
    await expect(tick(later)).resolves.toEqual({ unanswered: 2, page: 'already_paged' });
    expect(posted).toHaveLength(1);

    const nextHour = new Date(NOW.getTime() + HOUR);
    await text(parent, 16, { now: nextHour });
    await expect(tick(nextHour)).resolves.toMatchObject({ page: 'paged' });
    expect(posted).toHaveLength(2);
  });

  it('the canary household never pages through this path', async () => {
    await seedCanaryHousehold(db.database);
    const canary = await canaryChannel(db.database);
    if (!canary) throw new Error('no canary household');
    const household = { familyId: canary.familyId, parentUserId: canary.parentUserId };
    await text(household, 16);
    await text(household, 26);

    await expect(tick()).resolves.toEqual({ unanswered: 0, page: 'nothing_to_page' });
    expect(posted).toEqual([]);

    // Positive control: a real parent's text in the same tick is counted alone.
    await text(parent, 16);
    await expect(tick()).resolves.toEqual({ unanswered: 1, page: 'paged' });
    expect(posted).toEqual(['Hale: ops page. site parent_text_unanswered. count 1.']);
  });

  it('a group text the router stayed silent in does not page; one it never finished does', async () => {
    const silent = await text(parent, 20, { inGroup: true });
    await ledger(silent, 'sms_turn_unanswered', { reason: 'group_thread_unscoped' });
    await claim(silent);
    await expect(tick()).resolves.toEqual({ unanswered: 0, page: 'nothing_to_page' });

    await text(parent, 20, { inGroup: true });
    await expect(tick()).resolves.toEqual({ unanswered: 1, page: 'paged' });
  });

  it('the 2026-11-12 footprint pages: a text folded into ITSELF holds a claim and no answer', async () => {
    const selfFolded = await text(parent, 20);
    await claim(selfFolded);
    await ledger(selfFolded, 'sms_turn_folded', { into: selfFolded, read: 'read' });

    await expect(tick()).resolves.toEqual({ unanswered: 1, page: 'paged' });
  });

  it.each([
    { label: 'answered', actions: ['sms_turn_answered'], claimed: false, pages: false },
    {
      label: 'left unanswered with a reason',
      actions: ['sms_turn_unanswered'],
      claimed: false,
      pages: false,
    },
    {
      label: 'that failed (its own page)',
      actions: ['sms_turn_failed'],
      claimed: false,
      pages: false,
    },
    { label: 'claimed at the router exit', actions: [], claimed: true, pages: false },
    {
      label: 'folded into another text',
      actions: ['sms_turn_folded:other'],
      claimed: true,
      pages: false,
    },
    {
      label: 'deferred and never finished',
      actions: ['sms_turn_deferred'],
      claimed: false,
      pages: true,
    },
    { label: 'with no row at all', actions: [], claimed: false, pages: true },
  ] as const)('a text $label pages: $pages', async ({ actions, claimed, pages }) => {
    const anchor = await text(parent, 21);
    await ledger(anchor, 'sms_turn_answered');
    const id = await text(parent, 20);
    for (const action of actions) {
      if (action === 'sms_turn_folded:other') {
        await ledger(id, 'sms_turn_folded', { into: anchor, read: 'read' });
      } else {
        await ledger(id, action, action === 'sms_turn_answered' ? null : { reason: 'x' });
      }
    }
    if (claimed) await claim(id);

    const result = await tick();
    expect(result.unanswered).toBe(pages ? 1 : 0);
    expect(posted).toHaveLength(pages ? 1 : 0);
  });

  it('counts only texts the router owns, in the hour after their fifteen minutes', async () => {
    await text(parent, 20, { category: 'intake' });
    await text(parent, 20, { inGroup: null });
    await text(parent, 80);
    await expect(tick()).resolves.toEqual({ unanswered: 0, page: 'nothing_to_page' });

    // Positive control: the same family's routed 1:1 text in the window counts.
    await text(parent, 70);
    await expect(tick()).resolves.toEqual({ unanswered: 1, page: 'paged' });
  });
});
