import { describe, expect, it } from 'vitest';
import {
  OBSERVATION_WINDOW_DAYS,
  AUTONOMY_STREAK_REQUIRED,
  withinObservationWindow,
  streakSatisfiesAutonomy,
  teenRedactionCapApplies,
  type ActionApprovalRecord,
} from './autonomy-gate.js';

/**
 * Rule #4 gates as pure functions. Boundaries are hand-derived: the window is a
 * 7-day observe period keyed off families.createdAt; the streak needs ≥5
 * consecutive most-recent human-approved completions of the same type.
 */

const NOW = new Date('2026-06-12T12:00:00.000Z');

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

describe('withinObservationWindow — rule #4 7-day observe default', () => {
  it('day 6: family younger than 7 days is still in the observe window (no autonomy)', () => {
    expect(withinObservationWindow(daysAgo(6), NOW)).toBe(true);
  });

  it('day 8: family older than 7 days has cleared the observe window', () => {
    expect(withinObservationWindow(daysAgo(8), NOW)).toBe(false);
  });

  it('exactly 7 days (the boundary) has cleared the window — window is < 7 days old', () => {
    expect(withinObservationWindow(daysAgo(7), NOW)).toBe(false);
  });

  it('a family created in the future (clock skew) is treated as in-window', () => {
    expect(withinObservationWindow(daysAgo(-1), NOW)).toBe(true);
  });
});

describe('streakSatisfiesAutonomy — rule #4 per-action-type 5-streak', () => {
  function approved(actionType: string): ActionApprovalRecord {
    return { actionType, humanApproved: true };
  }
  function rejected(actionType: string): ActionApprovalRecord {
    return { actionType, humanApproved: false };
  }

  it('streak of 4 most-recent approvals is NOT enough', () => {
    const history = [
      approved('send_email'),
      approved('send_email'),
      approved('send_email'),
      approved('send_email'),
    ];
    expect(streakSatisfiesAutonomy('send_email', history)).toBe(false);
  });

  it('streak of exactly 5 most-recent approvals unlocks autonomy', () => {
    const history = [
      approved('send_email'),
      approved('send_email'),
      approved('send_email'),
      approved('send_email'),
      approved('send_email'),
    ];
    expect(streakSatisfiesAutonomy('send_email', history)).toBe(true);
  });

  it('a rejection inside the most-recent 5 resets the streak (4 approvals after a reject = not enough)', () => {
    // History is most-recent-first. The reject sits 5th-most-recent, so the
    // consecutive run of approvals from the top is only 4 → not enough.
    const history = [
      approved('send_email'),
      approved('send_email'),
      approved('send_email'),
      approved('send_email'),
      rejected('send_email'),
      approved('send_email'),
    ];
    expect(streakSatisfiesAutonomy('send_email', history)).toBe(false);
  });

  it('the streak is per-action-type: 5 approvals of another type do not unlock this one', () => {
    const history = [
      approved('place_supply_order'),
      approved('place_supply_order'),
      approved('place_supply_order'),
      approved('place_supply_order'),
      approved('place_supply_order'),
    ];
    expect(streakSatisfiesAutonomy('send_email', history)).toBe(false);
  });

  it('zero history → streak is 0 → autonomy stays dark (correct default)', () => {
    expect(streakSatisfiesAutonomy('send_email', [])).toBe(false);
  });

  it('interleaved types: the most-recent 5 of the target type, contiguous among themselves, count', () => {
    // Other-type rows are skipped, not treated as a break: the run of the
    // target type from the most recent backward is what matters.
    const history = [
      approved('send_email'),
      approved('place_supply_order'),
      approved('send_email'),
      approved('place_supply_order'),
      approved('send_email'),
      approved('send_email'),
      approved('send_email'),
    ];
    expect(streakSatisfiesAutonomy('send_email', history)).toBe(true);
  });

  it('a rejection of the SAME type breaks the run even with other types interleaved', () => {
    const history = [
      approved('send_email'),
      approved('send_email'),
      rejected('send_email'),
      approved('send_email'),
      approved('send_email'),
      approved('send_email'),
    ];
    expect(streakSatisfiesAutonomy('send_email', history)).toBe(false);
  });
});

describe('teenRedactionCapApplies — teen structural cap', () => {
  it('fires when a teenager is present AND the event is teen-content', () => {
    expect(teenRedactionCapApplies(['newborn', 'teenager'], true)).toBe(true);
  });

  it('does not fire when teen-content but no teenager in the family', () => {
    expect(teenRedactionCapApplies(['newborn', 'toddler'], true)).toBe(false);
  });

  it('does not fire when a teenager is present but the event is not teen-content', () => {
    expect(teenRedactionCapApplies(['teenager'], false)).toBe(false);
  });

  it('does not fire for the default newborn-only stage wiring (dormant cap)', () => {
    expect(teenRedactionCapApplies(['newborn'], true)).toBe(false);
  });
});

describe('rule #4 constants are the ratified values', () => {
  it('observation window is 7 days', () => {
    expect(OBSERVATION_WINDOW_DAYS).toBe(7);
  });
  it('streak required is 5', () => {
    expect(AUTONOMY_STREAK_REQUIRED).toBe(5);
  });
});
