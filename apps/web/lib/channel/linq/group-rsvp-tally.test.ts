import { describe, expect, it } from 'vitest';
import { householdKeyFor, tallyChangedMeaningfully, tallyHouseholds, tapbackVote } from './group-rsvp-tally';

describe('group RSVP tally', () => {
  it('counts one vote per household and fills pending from seats', () => {
    const tally = tallyHouseholds(
      [
        {
          householdKey: 'family:a',
          displayName: 'Priya',
          response: 'yes',
          familyId: 'a',
          calendarPermission: null,
          calendarEventId: null,
        },
        {
          householdKey: 'phone:sam',
          displayName: 'Sam',
          response: 'no',
          familyId: null,
          calendarPermission: null,
          calendarEventId: null,
        },
      ],
      ['family:a', 'family:b', 'phone:sam'],
    );
    expect(tally.yes).toBe(1);
    expect(tally.no).toBe(1);
    expect(tally.pending).toBe(1);
    expect(tally.yesNames).toEqual(['Priya']);
    expect(tally.noNames).toEqual(['Sam']);
  });

  it('a restated yes is not a meaningful change', () => {
    expect(tallyChangedMeaningfully({ yes: 2, no: 1, pending: 1 }, { yes: 2, no: 1, pending: 1 })).toBe(
      false,
    );
    expect(tallyChangedMeaningfully({ yes: 1, no: 1, pending: 2 }, { yes: 2, no: 1, pending: 1 })).toBe(
      true,
    );
    expect(tallyChangedMeaningfully(null, { yes: 0, no: 0, pending: 3 })).toBe(true);
  });

  it('reads carrier tapbacks as votes without scanning words', () => {
    expect(tapbackVote('like')).toBe('yes');
    expect(tapbackVote('love')).toBe('yes');
    expect(tapbackVote('emphasize')).toBe('yes');
    expect(tapbackVote('dislike')).toBe('no');
    expect(tapbackVote('question')).toBe('pending');
    expect(tapbackVote('laugh')).toBeNull();
  });

  it('keys a household by family when known, otherwise the phone hash', () => {
    expect(householdKeyFor({ familyId: 'abc', phoneHash: 'x' })).toBe('family:abc');
    expect(householdKeyFor({ familyId: null, phoneHash: 'x' })).toBe('phone:x');
    expect(householdKeyFor({ familyId: null, phoneHash: null })).toBeNull();
  });
});
