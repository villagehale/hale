import { describe, expect, it } from 'vitest';
import { cadencePreference, readCadencePreference } from './preference';

describe('cadence preference', () => {
  it('round-trips less and more, with the parent it belongs to', () => {
    expect(readCadencePreference(cadencePreference('parent-a', 'less', 'text me less'))).toEqual({
      schemaVersion: 1,
      parentUserId: 'parent-a',
      direction: 'less',
      note: 'text me less',
    });
    expect(
      readCadencePreference(cadencePreference('parent-a', 'more', 'send me more ideas'))?.direction,
    ).toBe('more');
  });

  it('rejects a preference that is not a cadence, or belongs to nobody', () => {
    expect(readCadencePreference({ direction: 'never' })).toBeNull();
    expect(readCadencePreference({ schemaVersion: 1, direction: 'less', note: 'x' })).toBeNull();
    expect(readCadencePreference('not_written_shadow')).toBeNull();
    expect(readCadencePreference(null)).toBeNull();
  });
});
