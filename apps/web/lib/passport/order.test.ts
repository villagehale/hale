import { describe, expect, it } from 'vitest';
import { sortStampsNewestFirst, stampRecency } from './order';

describe('stamp season order', () => {
  it('ranks a later season ahead of an earlier one', () => {
    expect(stampRecency('OCT 26')).toBeGreaterThan(stampRecency('SEP 26'));
    expect(stampRecency('SEP 26')).toBeGreaterThan(stampRecency('APR 26'));
    expect(stampRecency('APR 26')).toBeGreaterThan(stampRecency('DEC 25'));
    expect(stampRecency('DEC 25')).toBeGreaterThan(stampRecency('JUL 25'));
  });

  it('sorts newest face first and keeps ties stable', () => {
    const sorted = sortStampsNewestFirst([
      { id: 'soccer', face: 'APR 26' },
      { id: 'ballet', face: 'OCT 26' },
      { id: 'karate', face: 'SEP 26' },
      { id: 'aquarium', face: 'JUL 25' },
    ]);
    expect(sorted.map((stamp) => stamp.id)).toEqual(['ballet', 'karate', 'soccer', 'aquarium']);
  });
});
