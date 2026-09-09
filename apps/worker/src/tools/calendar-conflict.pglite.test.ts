import { schema } from '@hale/db';
import { type CalendarConflictOutput, calendarConflictOutput } from '@hale/tools-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '../testing/pglite.js';
import { invokeReviewerTool } from './registry.js';

/**
 * VIL-270 · the reviewer's own reach into family_events.
 *
 * The reviewer is a third-party model (teen-access-outbound doctrine), and
 * `check_calendar_conflict` is FORCED on every calendar draft. It answered with the
 * overlapping rows' raw titles and no teen or sensitive filter, so a private SIBLING
 * event in the window reached Anthropic verbatim on a draft that had nothing to do
 * with it — after the channel's own projection had already closed the drafted row.
 *
 * The fix is a subtraction rather than a filter: a verdict about a TIME COLLISION
 * needs the window and the id, never the words. Withholding the title is what makes
 * the leak unexpressible; filtering private rows out would have made the reviewer
 * blind to a real double-booking instead.
 */

const HOUR = 60 * 60 * 1000;
const START = new Date('2026-07-30T20:00:00.000Z');
const TEEN_TITLE = 'Dr. Patel — eating-disorder therapy';

describe('check_calendar_conflict — the overlap, not the item', () => {
  let db: TestDb;
  let familyId: string;

  // Booted in a hook, not the test body: pglite boot + migrations exceed the 5s test
  // timeout, and hooks carry their own budget.
  beforeEach(async () => {
    db = await createTestDb();
    ({ familyId } = await seedFamily(db.database));
  });

  afterEach(async () => {
    await db.close();
  });

  async function seedEvent(title: string, startsAt: Date, endsAt: Date | null): Promise<string> {
    const [row] = await db.database
      .insert(schema.familyEvents)
      .values({ familyId, title, startsAt, endsAt, source: 'channel' })
      .returning({ id: schema.familyEvents.id });
    if (!row) throw new Error('family_events insert returned no row');
    return row.id;
  }

  async function conflicts(): Promise<{ raw: unknown; parsed: CalendarConflictOutput }> {
    const result = await invokeReviewerTool(
      'check_calendar_conflict',
      { familyId, startsAt: START.toISOString(), durationMinutes: 60 },
      db.database,
    );
    // The RAW result is what reviewer.ts:267 stringifies into the model's turn, so the
    // assertions below run on it. Parsing here as well would strip a re-grown column and
    // hide the very regression this test exists for.
    return { raw: result.result, parsed: calendarConflictOutput.parse(result.result) };
  }

  it('reports the overlap by id and window, and hands the model no title', async () => {
    const eventId = await seedEvent(TEEN_TITLE, new Date(START.getTime() + 15 * 60 * 1000), null);

    const { raw, parsed } = await conflicts();

    const rawEvents = (raw as { conflictingEvents: Record<string, unknown>[] }).conflictingEvents;
    expect(Object.keys(rawEvents[0] ?? {}).sort()).toEqual(['endsAt', 'id', 'startsAt']);
    expect(JSON.stringify(raw)).not.toContain(TEEN_TITLE);
    expect(parsed.hasConflict).toBe(true);
    expect(parsed.conflictingEvents.map((e) => e.id)).toEqual([eventId]);
  });

  it('still says no conflict when nothing overlaps — the check did not go blind', async () => {
    await seedEvent('Swim lesson', new Date(START.getTime() + 3 * HOUR), null);

    const { parsed } = await conflicts();

    expect(parsed.hasConflict).toBe(false);
    expect(parsed.conflictingEvents).toEqual([]);
  });
});
