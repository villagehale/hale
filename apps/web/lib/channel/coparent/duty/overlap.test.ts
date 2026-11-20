import { describe, expect, it } from 'vitest';
import type { DutyOccasion } from './cadence';
import { eventsConflictWithTravel, findSplitDutyPair } from './overlap';

const MONDAY_NINE = new Date('2026-09-28T13:00:00.000Z');
const MONDAY_NINE_THIRTY = new Date('2026-09-28T13:30:00.000Z');
const MONDAY_TEN = new Date('2026-09-28T14:00:00.000Z');
const MONDAY_TEN_THIRTY = new Date('2026-09-28T14:30:00.000Z');
const TUESDAY = new Date('2026-09-29T13:00:00.000Z');

function occ(
  partial: Partial<DutyOccasion> & Pick<DutyOccasion, 'eventKey' | 'kid'>,
): DutyOccasion {
  return {
    role: 'attend',
    startsAt: MONDAY_NINE,
    endsAt: MONDAY_TEN,
    hasOwner: false,
    conflict: false,
    needsWhichKid: false,
    cancelled: false,
    hasDutyRecord: false,
    reasked: false,
    source: 'calendar',
    ...partial,
  };
}

describe('eventsConflictWithTravel', () => {
  it('detects clock overlap without travel', () => {
    expect(
      eventsConflictWithTravel(
        { startsAt: MONDAY_NINE, endsAt: MONDAY_TEN },
        { startsAt: MONDAY_NINE_THIRTY, endsAt: MONDAY_TEN_THIRTY },
        null,
      ),
    ).toBe(true);
  });

  it('lets back-to-back events pass when travel is unknown or zero', () => {
    expect(
      eventsConflictWithTravel(
        { startsAt: MONDAY_NINE, endsAt: MONDAY_TEN },
        { startsAt: MONDAY_TEN, endsAt: MONDAY_TEN_THIRTY },
        null,
      ),
    ).toBe(false);
    expect(
      eventsConflictWithTravel(
        { startsAt: MONDAY_NINE, endsAt: MONDAY_TEN },
        { startsAt: MONDAY_TEN, endsAt: MONDAY_TEN_THIRTY },
        0,
      ),
    ).toBe(false);
  });

  it('treats a gap shorter than travel as a clash', () => {
    expect(
      eventsConflictWithTravel(
        { startsAt: MONDAY_NINE, endsAt: MONDAY_TEN },
        { startsAt: MONDAY_TEN_THIRTY, endsAt: TUESDAY },
        40,
      ),
    ).toBe(true);
    expect(
      eventsConflictWithTravel(
        { startsAt: MONDAY_NINE, endsAt: MONDAY_TEN },
        { startsAt: MONDAY_TEN_THIRTY, endsAt: TUESDAY },
        20,
      ),
    ).toBe(false);
  });
});

describe('findSplitDutyPair', () => {
  it('spots two different kids overlapping on the same morning', () => {
    const pair = findSplitDutyPair(
      [
        occ({ eventKey: 'hockey', kid: 'Maya', eventLabel: 'hockey' }),
        occ({
          eventKey: 'dance',
          kid: 'Leo',
          eventLabel: 'dance',
          startsAt: MONDAY_NINE_THIRTY,
          endsAt: MONDAY_TEN_THIRTY,
        }),
      ],
      () => null,
    );
    expect(pair?.first.eventKey).toBe('hockey');
    expect(pair?.second.eventKey).toBe('dance');
  });

  it('does not treat the same child as a split', () => {
    expect(
      findSplitDutyPair(
        [
          occ({ eventKey: 'hockey', kid: 'Maya', childId: 'c-maya' }),
          occ({
            eventKey: 'piano',
            kid: 'Maya',
            childId: 'c-maya',
            startsAt: MONDAY_NINE_THIRTY,
            endsAt: MONDAY_TEN_THIRTY,
          }),
        ],
        () => null,
      ),
    ).toBeNull();
  });

  it('can include a settled pair for a change of mind', () => {
    const pair = findSplitDutyPair(
      [
        occ({
          eventKey: 'hockey',
          kid: 'Maya',
          hasOwner: true,
          spokenUserIds: ['sam'],
          spokenName: 'Sam',
        }),
        occ({
          eventKey: 'dance',
          kid: 'Leo',
          startsAt: MONDAY_NINE_THIRTY,
          endsAt: MONDAY_TEN_THIRTY,
          hasOwner: true,
          spokenUserIds: ['ana'],
          spokenName: 'Ana',
        }),
      ],
      () => null,
      { includeSettled: true },
    );
    expect(pair?.first.eventKey).toBe('hockey');
    expect(pair?.second.eventKey).toBe('dance');
  });

  it('skips a pair already split across two owners', () => {
    expect(
      findSplitDutyPair(
        [
          occ({
            eventKey: 'hockey',
            kid: 'Maya',
            hasOwner: true,
            spokenUserIds: ['sam'],
            spokenName: 'Sam',
          }),
          occ({
            eventKey: 'dance',
            kid: 'Leo',
            startsAt: MONDAY_NINE_THIRTY,
            endsAt: MONDAY_TEN_THIRTY,
            hasOwner: true,
            spokenUserIds: ['ana'],
            spokenName: 'Ana',
          }),
        ],
        () => null,
      ),
    ).toBeNull();
  });

  it('skips when one parent already takes both', () => {
    expect(
      findSplitDutyPair(
        [
          occ({
            eventKey: 'hockey',
            kid: 'Maya',
            hasOwner: true,
            spokenUserIds: ['sam'],
            spokenName: 'Sam',
          }),
          occ({
            eventKey: 'dance',
            kid: 'Leo',
            startsAt: MONDAY_NINE_THIRTY,
            endsAt: MONDAY_TEN_THIRTY,
            hasOwner: true,
            spokenUserIds: ['sam'],
            spokenName: 'Sam',
          }),
        ],
        () => null,
      ),
    ).toBeNull();
  });

  it('uses travel minutes when the clocks do not overlap', () => {
    const pair = findSplitDutyPair(
      [
        occ({ eventKey: 'hockey', kid: 'Maya', endsAt: MONDAY_TEN }),
        occ({
          eventKey: 'dance',
          kid: 'Leo',
          startsAt: MONDAY_TEN_THIRTY,
          endsAt: TUESDAY,
        }),
      ],
      () => 40,
    );
    expect(pair?.travelMinutes).toBe(40);
    expect(
      findSplitDutyPair(
        [
          occ({ eventKey: 'hockey', kid: 'Maya', endsAt: MONDAY_TEN }),
          occ({
            eventKey: 'dance',
            kid: 'Leo',
            startsAt: MONDAY_TEN_THIRTY,
            endsAt: TUESDAY,
          }),
        ],
        () => 10,
      ),
    ).toBeNull();
  });
});
