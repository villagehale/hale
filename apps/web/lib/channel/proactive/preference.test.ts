import { describe, expect, it } from 'vitest';
import { cadencePreference, readCadencePreference } from './preference';

describe('cadence preference', () => {
  it('round-trips less and more, with the parent it belongs to', () => {
    expect(readCadencePreference(cadencePreference('parent-a', 'less'))).toEqual({
      schemaVersion: 1,
      parentUserId: 'parent-a',
      direction: 'less',
    });
    expect(readCadencePreference(cadencePreference('parent-a', 'more'))?.direction).toBe('more');
  });

  it('carries no words, even from a row that had some', () => {
    expect(
      readCadencePreference({ ...cadencePreference('parent-a', 'less'), note: 'text me less' }),
    ).toEqual({ schemaVersion: 1, parentUserId: 'parent-a', direction: 'less' });
  });

  it('rejects a preference that is not a cadence, or belongs to nobody', () => {
    expect(readCadencePreference({ direction: 'never' })).toBeNull();
    expect(readCadencePreference({ schemaVersion: 1, direction: 'less' })).toBeNull();
    expect(readCadencePreference('not_written_shadow')).toBeNull();
    expect(readCadencePreference(null)).toBeNull();
  });
});
