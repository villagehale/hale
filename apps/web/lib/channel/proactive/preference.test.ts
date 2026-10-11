import { describe, expect, it } from 'vitest';
import { cadenceFactValue, readCadenceFact } from './preference';

describe('cadence preference fact', () => {
  it('round-trips less and more', () => {
    expect(readCadenceFact(cadenceFactValue('less', 'text me less'))).toEqual({
      schemaVersion: 1,
      direction: 'less',
      note: 'text me less',
    });
    expect(readCadenceFact(cadenceFactValue('more', 'send me more ideas'))?.direction).toBe('more');
  });

  it('rejects a fact that is not a cadence', () => {
    expect(readCadenceFact({ direction: 'never' })).toBeNull();
    expect(readCadenceFact({ schemaVersion: 1, direction: 'less' })).toBeNull();
    expect(readCadenceFact(null)).toBeNull();
  });
});
