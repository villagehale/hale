import { describe, expect, it } from 'vitest';
import { type CorrelationCandidate, correlateExtraction } from './correlate';

/**
 * Deterministic correlation, tested against fixture calendars (rule: "matching
 * is deterministic code, not the LLM — testable without model"). No Anthropic
 * client anywhere in this file.
 */

const swimClass: CorrelationCandidate = {
  ref: { table: 'family_events', id: 'fe-1' },
  title: 'Swim lessons',
  startsAt: '2026-08-01T14:00:00Z',
};
const soccerPractice: CorrelationCandidate = {
  ref: { table: 'week_plans_item', id: 'wp-1' },
  title: 'Soccer practice',
  startsAt: '2026-08-03T18:00:00Z',
};
const dayCoarseCheckup: CorrelationCandidate = {
  ref: { table: 'week_plans_item', id: 'wp-2' },
  title: 'Pediatric checkup',
  startsAt: null,
};

const CANDIDATES = [swimClass, soccerPractice, dayCoarseCheckup];

describe('correlateExtraction', () => {
  it('matches a cancellation to the family_events row with the same title + original time', () => {
    const match = correlateExtraction(
      {
        kind: 'cancellation',
        title: 'Swim Class — CANCELLED',
        originalTime: '2026-08-01T14:00:00Z',
        newTime: null,
      },
      CANDIDATES,
    );
    expect(match).toEqual({ table: 'family_events', id: 'fe-1' });
  });

  it('matches a reschedule to the week_plans item at its original time, not its new time', () => {
    const match = correlateExtraction(
      {
        kind: 'reschedule',
        title: 'Soccer practice moved',
        originalTime: '2026-08-03T18:00:00Z',
        newTime: '2026-08-05T18:00:00Z',
      },
      CANDIDATES,
    );
    expect(match).toEqual({ table: 'week_plans_item', id: 'wp-1' });
  });

  it('matches a new_event to its stated time when it duplicates a known placement', () => {
    const match = correlateExtraction(
      { kind: 'new_event', title: 'Swim lessons this week', originalTime: null, newTime: '2026-08-01T15:00:00Z' },
      CANDIDATES,
    );
    expect(match).toEqual({ table: 'family_events', id: 'fe-1' });
  });

  it('returns null for a genuinely new occasion with no title/time overlap', () => {
    const match = correlateExtraction(
      { kind: 'new_event', title: "Leo's birthday party", originalTime: null, newTime: '2026-08-10T15:00:00Z' },
      CANDIDATES,
    );
    expect(match).toBeNull();
  });

  it('returns null when the time is outside the window even if the title matches exactly', () => {
    const match = correlateExtraction(
      { kind: 'cancellation', title: 'Swim lessons', originalTime: '2026-08-05T14:00:00Z', newTime: null },
      CANDIDATES,
    );
    expect(match).toBeNull();
  });

  it('returns null when the time matches but the title is unrelated', () => {
    const match = correlateExtraction(
      { kind: 'cancellation', title: 'Dentist appointment', originalTime: '2026-08-01T14:00:00Z', newTime: null },
      CANDIDATES,
    );
    expect(match).toBeNull();
  });

  it('never matches a day-coarse candidate with no startsAt', () => {
    const match = correlateExtraction(
      { kind: 'cancellation', title: 'Pediatric checkup', originalTime: '2026-08-01T09:00:00Z', newTime: null },
      CANDIDATES,
    );
    expect(match).toBeNull();
  });

  it('never attempts correlation for reminder_only or unclear extractions', () => {
    expect(
      correlateExtraction(
        { kind: 'reminder_only', title: 'Swim lessons', originalTime: '2026-08-01T14:00:00Z', newTime: null },
        CANDIDATES,
      ),
    ).toBeNull();
    expect(
      correlateExtraction(
        { kind: 'unclear', title: 'Swim lessons', originalTime: '2026-08-01T14:00:00Z', newTime: null },
        CANDIDATES,
      ),
    ).toBeNull();
  });

  it('returns null with no candidates', () => {
    const match = correlateExtraction(
      { kind: 'cancellation', title: 'Swim lessons', originalTime: '2026-08-01T14:00:00Z', newTime: null },
      [],
    );
    expect(match).toBeNull();
  });
});
