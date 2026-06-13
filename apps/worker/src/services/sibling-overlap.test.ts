import { describe, expect, it } from 'vitest';
import { detectSiblingCalendarOverlaps, type CalendarActionInput } from './sibling-overlap.js';

/**
 * Sibling calendar-overlap detector — a pure function. The invariant: two
 * calendar actions (create/update_calendar_event) for DIFFERENT children whose
 * time windows overlap produce one coordination flag. It is a FLAG, never a
 * block. Cases where overlap cannot be determined (missing/unparseable times,
 * same child, non-calendar actions, an unattributed action) produce NO flag —
 * we surface honest signals only, never fabricate one.
 */

const MIA = '11111111-1111-1111-1111-111111111111';
const NOAH = '22222222-2222-2222-2222-222222222222';

function calAction(
  actionId: string,
  childId: string | null,
  startsAt: string,
  extra: Record<string, unknown> = {},
): CalendarActionInput {
  return {
    actionId,
    childId,
    actionType: 'create_calendar_event',
    payload: { title: actionId, startsAt, ...extra },
  };
}

describe('detectSiblingCalendarOverlaps', () => {
  it('flags two different children whose windows overlap (default duration)', () => {
    const flags = detectSiblingCalendarOverlaps([
      calAction('a-mia', MIA, '2026-09-10T16:30:00-04:00'),
      calAction('a-noah', NOAH, '2026-09-10T16:45:00-04:00'),
    ]);
    expect(flags).toHaveLength(1);
    const flag = flags[0];
    expect(flag?.kind).toBe('sibling_calendar_overlap');
    // The flag names the later action's child and the sibling it overlaps.
    expect([flag?.childId, flag?.siblingChildId].sort()).toEqual([MIA, NOAH].sort());
  });

  it('respects explicit endsAt — non-overlapping adjacent windows do NOT flag', () => {
    const flags = detectSiblingCalendarOverlaps([
      calAction('a-mia', MIA, '2026-09-10T16:00:00-04:00', { endsAt: '2026-09-10T16:30:00-04:00' }),
      calAction('a-noah', NOAH, '2026-09-10T16:30:00-04:00', { endsAt: '2026-09-10T17:00:00-04:00' }),
    ]);
    expect(flags).toHaveLength(0);
  });

  it('uses durationMin to bound the window', () => {
    const flags = detectSiblingCalendarOverlaps([
      calAction('a-mia', MIA, '2026-09-10T16:00:00-04:00', { durationMin: 90 }),
      calAction('a-noah', NOAH, '2026-09-10T17:00:00-04:00', { durationMin: 30 }),
    ]);
    expect(flags).toHaveLength(1);
  });

  it('does NOT flag two events for the SAME child', () => {
    const flags = detectSiblingCalendarOverlaps([
      calAction('a-1', MIA, '2026-09-10T16:30:00-04:00'),
      calAction('a-2', MIA, '2026-09-10T16:45:00-04:00'),
    ]);
    expect(flags).toHaveLength(0);
  });

  it('does NOT flag when one of the actions is unattributed (childId null)', () => {
    const flags = detectSiblingCalendarOverlaps([
      calAction('a-mia', MIA, '2026-09-10T16:30:00-04:00'),
      calAction('a-unk', null, '2026-09-10T16:45:00-04:00'),
    ]);
    expect(flags).toHaveLength(0);
  });

  it('ignores non-calendar actions', () => {
    const flags = detectSiblingCalendarOverlaps([
      calAction('a-mia', MIA, '2026-09-10T16:30:00-04:00'),
      {
        actionId: 'a-email',
        childId: NOAH,
        actionType: 'send_email',
        payload: { startsAt: '2026-09-10T16:45:00-04:00' },
      },
    ]);
    expect(flags).toHaveLength(0);
  });

  it('does NOT flag when a start time is missing or unparseable', () => {
    const flags = detectSiblingCalendarOverlaps([
      { actionId: 'a-mia', childId: MIA, actionType: 'create_calendar_event', payload: {} },
      calAction('a-noah', NOAH, 'not-a-date'),
    ]);
    expect(flags).toHaveLength(0);
  });
});
