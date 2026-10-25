import { describe, expect, it } from 'vitest';
import { proactiveSearchSubject } from './moments';

describe('proactiveSearchSubject', () => {
  it('hands the model the family-local date, not UTC', () => {
    // 03:30Z on Nov 1 is still Oct 31 in Toronto.
    expect(proactiveSearchSubject(new Date('2026-11-01T03:30:00Z'), 'America/Toronto')).toContain(
      'Today is 2026-10-31',
    );
  });
  it('names no holiday itself: the model works them out', () => {
    const subject = proactiveSearchSubject(new Date('2026-10-25T16:00:00Z'), 'America/Toronto');
    expect(subject).not.toMatch(/halloween|christmas|easter/i);
    expect(subject).toContain('holidays and seasonal moments');
  });
  it('carries the family language when known', () => {
    expect(
      proactiveSearchSubject(new Date('2026-10-25T16:00:00Z'), 'America/Toronto', 'zh'),
    ).toContain("family's language is zh");
  });
});
