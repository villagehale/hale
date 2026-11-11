import { describe, expect, it } from 'vitest';
import type { SiteChoice } from '../site-choices';
import { toMismatchReading } from './mismatch-reader';

const CHOICES: SiteChoice[] = [
  {
    id: 'nov-21',
    label: 'Nov 21',
    starts_at: '2026-11-21',
    price_cents: 12000,
    waitlist: false,
    billing_note: 'billed December',
  },
];

describe('mismatch reading', () => {
  it('accepts a real site choice and refuses an invented id', () => {
    expect(
      toMismatchReading(
        { reason: 'they named it', verdict: 'option', choiceId: 'nov-21', question: null },
        CHOICES,
      ),
    ).toEqual({ verdict: 'option', choiceId: 'nov-21' });
    expect(
      toMismatchReading(
        { reason: 'invented', verdict: 'option', choiceId: 'jan-1', question: null },
        CHOICES,
      ),
    ).toBeNull();
  });

  it('reads waitlist, email, and unrelated without picking', () => {
    expect(
      toMismatchReading(
        { reason: 'wait', verdict: 'waitlist', choiceId: null, question: null },
        CHOICES,
      ),
    ).toEqual({ verdict: 'waitlist' });
    expect(
      toMismatchReading(
        { reason: 'mail', verdict: 'email', choiceId: null, question: null },
        CHOICES,
      ),
    ).toEqual({ verdict: 'email' });
    expect(
      toMismatchReading(
        { reason: 'other', verdict: 'unrelated', choiceId: null, question: null },
        CHOICES,
      ),
    ).toEqual({ verdict: 'unrelated' });
  });
});
