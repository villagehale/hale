import { describe, expect, it } from 'vitest';
import { NEXT_DAY_CHECKBACK_TEMPLATE_KEY, nextDayCheckbackDedupeKey } from './claim';

describe('next-day check-back keys', () => {
  it('names the template and keys one check-back per workstream', () => {
    const id = '0b6f1c1e-6a3e-4c55-9d8e-2f7d4b0b9a11';
    expect(NEXT_DAY_CHECKBACK_TEMPLATE_KEY).toBe('next-day-checkback');
    expect(nextDayCheckbackDedupeKey(id)).toBe(`next-day-checkback:${id}`);
  });
});
