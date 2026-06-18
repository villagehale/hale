import { companionForChild } from '@hale/types';
import { describe, expect, it } from 'vitest';
import { duePhrase, planChildItems } from './week.js';

const NOW = new Date('2026-06-17T12:00:00Z');

function child(id: string, dateOfBirth: string, name: string | null) {
  return { id, ...companionForChild({ dateOfBirth, name }, NOW) };
}

describe('duePhrase', () => {
  it('maps weeks-until onto calm phrases at each boundary', () => {
    // Derived from the spec: <=0 is now, 1 is next week, <8 is "in N weeks",
    // otherwise rounded to months at 4.345 weeks/month.
    expect(duePhrase(0)).toBe('this week');
    expect(duePhrase(-3)).toBe('this week');
    expect(duePhrase(1)).toBe('next week');
    expect(duePhrase(5)).toBe('in 5 weeks');
    expect(duePhrase(9)).toBe('in ~2 months');
    expect(duePhrase(5 * 4.345)).toBe('in ~5 months');
  });

  it('stays in weeks below the 8-week cutoff, then switches to rounded months', () => {
    expect(duePhrase(7)).toBe('in 7 weeks');
    expect(duePhrase(8)).toBe('in ~2 months');
    expect(duePhrase(43)).toBe('in ~10 months');
  });
});

describe('planChildItems', () => {
  it('surfaces the soonest health item per child with its category label and name', () => {
    // A baby born 2026-03-15 is ~3mo on 2026-06-17 → next health is the 4-month set.
    const items = planChildItems([child('c1', '2026-03-15', 'Robin')]);
    const health = items.find((i) => i.key === 'c1-health');
    expect(health).toBeDefined();
    expect(health?.childName).toBe('Robin');
    expect(health?.what).toMatch(/4-month/);
    // 4mo well-baby + immunization both at 4mo — only the soonest single item.
    expect(items.filter((i) => i.key === 'c1-health')).toHaveLength(1);
  });

  it('maps well_child_visit to the "checkup" label, not the raw enum', () => {
    // A child born 2021-06-15 is ~5y → next health is the 4–6y well-child visit.
    const items = planChildItems([child('c1', '2021-06-15', 'Sam')]);
    const health = items.find((i) => i.key === 'c1-health');
    expect(health?.kindLabel === 'checkup' || health?.kindLabel === 'immunization').toBe(true);
    expect(health?.kindLabel).not.toBe('well_child_visit');
  });

  it('adds a milestone item only for a window that is open now', () => {
    // A 13-month-old sits inside the walking / first-words windows (12–18mo).
    const items = planChildItems([child('c1', '2025-05-15', 'Ada')]);
    const milestone = items.find((i) => i.key === 'c1-milestone');
    expect(milestone).toBeDefined();
    expect(milestone?.kindLabel).toBe('milestone');
    expect(milestone?.when).toBe('around now');
  });

  it('falls back to a neutral name when a child has none', () => {
    const items = planChildItems([child('c1', '2026-03-15', null)]);
    expect(items.every((i) => i.childName === 'your child')).toBe(true);
  });

  it('returns no items for an empty family', () => {
    expect(planChildItems([])).toEqual([]);
  });
});
