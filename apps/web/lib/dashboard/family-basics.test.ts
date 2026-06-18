import { describe, expect, it } from 'vitest';
import { toFamilyBasics } from './family-basics.js';

const NOW = new Date('2026-06-17T12:00:00Z');

describe('toFamilyBasics', () => {
  it('passes the area through and derives each child stage live from date_of_birth', () => {
    const view = toFamilyBasics(
      'M4L',
      [
        { id: 'a', name: 'Robin', dateOfBirth: '2026-03-15' }, // ~3mo → newborn
        { id: 'b', name: 'Sam', dateOfBirth: '2010-01-01' }, // 16y → teenager
      ],
      NOW,
    );

    expect(view.areaCoarse).toBe('M4L');
    expect(view.children).toEqual([
      { id: 'a', name: 'Robin', dateOfBirth: '2026-03-15', stageLabel: 'newborn' },
      { id: 'b', name: 'Sam', dateOfBirth: '2010-01-01', stageLabel: 'teenager' },
    ]);
  });

  it('keeps a null area null (never fabricates one)', () => {
    const view = toFamilyBasics(null, [], NOW);
    expect(view.areaCoarse).toBeNull();
    expect(view.children).toEqual([]);
  });
});
