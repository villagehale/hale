import { schema } from '@hale/db';
import type { WeekPlanItem } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { mintCalendarDraftsForWeekPlan, zonedDayStartInstant } from './mint-placements.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const WEEK_START = '2026-07-06';
const TZ = 'America/Toronto';
const ACTOR = 'user_primary';

/**
 * Fakes the narrow insert surface the mint uses:
 *   insert(events).values(v).onConflictDoNothing().returning() → `eventReturns`
 *     (an empty array simulates the recompose conflict — the row already exists).
 *   insert(actions).values(v).onConflictDoNothing().returning() → [{id}]
 *   insert(audit_log).values(v) → resolves
 * Every insert's values are captured so a test can assert the dedup hash stamped on
 * the synthetic event and whether an action was minted at all.
 */
function fakeDb(opts: { eventReturns: Array<{ id: string }> }) {
  const eventInserts: Record<string, unknown>[] = [];
  const actionInserts: Record<string, unknown>[] = [];

  const insert = (table: unknown) => ({
    values: (v: Record<string, unknown>) => {
      if (table === schema.events) {
        eventInserts.push(v);
        return { onConflictDoNothing: () => ({ returning: async () => opts.eventReturns }) };
      }
      if (table === schema.actions) {
        actionInserts.push(v);
        return { onConflictDoNothing: () => ({ returning: async () => [{ id: 'act-1' }] }) };
      }
      return Promise.resolve(undefined);
    },
  });

  return { db: { insert } as never, eventInserts, actionInserts };
}

/** A client that fails the test if the review path is ever reached — proving the
 * dedup/skip control flow never touches the LLM. */
const noLlmClient = {
  messages: {
    create: vi.fn(() => {
      throw new Error('LLM must not be called on the dedup/skip path');
    }),
  },
} as never;

function item(overrides: Partial<WeekPlanItem> = {}): WeekPlanItem {
  return {
    kind: 'village',
    title: 'Swim class',
    childIds: [],
    startsAt: '2026-07-08',
    endsAt: null,
    location: 'Rec Centre',
    sourceRef: { table: 'village_saves', id: 'vs-1' },
    needs: 'calendar_add',
    privacySensitive: false,
    ...overrides,
  };
}

describe('mintCalendarDraftsForWeekPlan — recompose idempotency', () => {
  it('a recompose of the SAME item yields the SAME dedup hash (so onConflictDoNothing dedups)', async () => {
    const first = fakeDb({ eventReturns: [] });
    const second = fakeDb({ eventReturns: [] });

    await mintCalendarDraftsForWeekPlan(
      { familyId: FAMILY_ID, weekStart: WEEK_START, items: [item()], timeZone: TZ, actor: ACTOR },
      first.db,
      noLlmClient,
    );
    await mintCalendarDraftsForWeekPlan(
      { familyId: FAMILY_ID, weekStart: WEEK_START, items: [item()], timeZone: TZ, actor: ACTOR },
      second.db,
      noLlmClient,
    );

    expect(first.eventInserts[0]?.dedupHash).toBeDefined();
    expect(first.eventInserts[0]?.dedupHash).toEqual(second.eventInserts[0]?.dedupHash);
  });

  it('a sourceRef item and an appointment item (null sourceRef) get DIFFERENT dedup hashes', async () => {
    const { db, eventInserts } = fakeDb({ eventReturns: [] });
    await mintCalendarDraftsForWeekPlan(
      {
        familyId: FAMILY_ID,
        weekStart: WEEK_START,
        items: [
          item({ sourceRef: { table: 'village_saves', id: 'vs-1' } }),
          item({ kind: 'appointment', title: 'Checkup', sourceRef: null, startsAt: '2026-07-09' }),
        ],
        timeZone: TZ,
        actor: ACTOR,
      },
      db,
      noLlmClient,
    );
    expect(eventInserts).toHaveLength(2);
    expect(eventInserts[0]?.dedupHash).not.toEqual(eventInserts[1]?.dedupHash);
  });

  it('when the event dedup hash collides on recompose, it SKIPS — no action, no review', async () => {
    const { db, actionInserts } = fakeDb({ eventReturns: [] }); // [] = conflict (already minted)
    const result = await mintCalendarDraftsForWeekPlan(
      { familyId: FAMILY_ID, weekStart: WEEK_START, items: [item()], timeZone: TZ, actor: ACTOR },
      db,
      noLlmClient,
    );

    expect(result).toEqual({ minted: [], skipped: 1 });
    expect(actionInserts).toHaveLength(0);
    expect((noLlmClient as { messages: { create: ReturnType<typeof vi.fn> } }).messages.create).not.toHaveBeenCalled();
  });

  it('ignores items that do not need placement, or have no day', async () => {
    const { db, eventInserts } = fakeDb({ eventReturns: [] });
    await mintCalendarDraftsForWeekPlan(
      {
        familyId: FAMILY_ID,
        weekStart: WEEK_START,
        items: [
          item({ needs: 'none' }),
          item({ needs: 'decision' }),
          item({ needs: 'calendar_add', startsAt: null }), // undated → not placeable
        ],
        timeZone: TZ,
        actor: ACTOR,
      },
      db,
      noLlmClient,
    );
    expect(eventInserts).toHaveLength(0);
  });
});

describe('zonedDayStartInstant — family-local day-key → UTC instant', () => {
  it('resolves a summer day in Toronto (EDT, UTC-4) to 04:00Z', () => {
    expect(zonedDayStartInstant('2026-07-06', 'America/Toronto').toISOString()).toBe(
      '2026-07-06T04:00:00.000Z',
    );
  });

  it('resolves a winter day in Toronto (EST, UTC-5) to 05:00Z', () => {
    expect(zonedDayStartInstant('2026-01-06', 'America/Toronto').toISOString()).toBe(
      '2026-01-06T05:00:00.000Z',
    );
  });
});
