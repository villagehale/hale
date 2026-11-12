import { describe, expect, it } from 'vitest';
import type { SiteChoice } from '../site-choices';
import { signupMismatchReadUserMessage, toMismatchReading } from './mismatch-reader';

const CHOICES: SiteChoice[] = [
  {
    id: 'nov-21',
    label: 'Nov 21',
    starts_at: '2026-11-21',
    price_cents: 12000,
    waitlist: false,
    billing_note: 'billed December',
  },
  {
    id: 'jan-wait',
    label: 'January waitlist',
    starts_at: '2027-01-09',
    price_cents: 9800,
    waitlist: true,
    billing_note: null,
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

  it('reads waitlist, email, and unrelated without picking an option', () => {
    expect(
      toMismatchReading(
        { reason: 'wait', verdict: 'waitlist', choiceId: null, question: null },
        CHOICES,
      ),
    ).toEqual({ verdict: 'waitlist', choiceId: 'jan-wait' });
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

  it('keeps a waitlist choice only when the site marks that choice a waitlist', () => {
    const wait = (choiceId: string | null) =>
      toMismatchReading({ reason: 'r', verdict: 'waitlist', choiceId, question: null }, CHOICES);
    expect(wait('jan-wait')).toEqual({ verdict: 'waitlist', choiceId: 'jan-wait' });
    // One waitlist on the page: a waitlist pick can only be that one.
    expect(wait(null)).toEqual({ verdict: 'waitlist', choiceId: 'jan-wait' });
    expect(wait('nov-21')).toEqual({ verdict: 'waitlist', choiceId: 'jan-wait' });
    // Positive control: with two waitlists and none named, none is picked.
    const two = [
      ...CHOICES,
      { ...CHOICES[1], id: 'feb-wait', label: 'February waitlist' },
    ] as SiteChoice[];
    expect(
      toMismatchReading({ reason: 'r', verdict: 'waitlist', choiceId: null, question: null }, two),
    ).toEqual({ verdict: 'waitlist', choiceId: null });
    expect(
      toMismatchReading(
        { reason: 'r', verdict: 'waitlist', choiceId: 'nov-21', question: null },
        two,
      ),
    ).toEqual({ verdict: 'waitlist', choiceId: null });
  });

  it('reads a retry: the provider fixed it, try what they asked for again', () => {
    expect(
      toMismatchReading({ reason: 'r', verdict: 'retry', choiceId: null, question: null }, CHOICES),
    ).toEqual({ verdict: 'retry' });
  });

  it('tells the reader an email was drafted only when one was', () => {
    const base = { text: 'they said January works', askedStart: 'January', choices: CHOICES };
    expect(JSON.parse(signupMismatchReadUserMessage({ ...base, emailed: true })).emailed).toBe(
      true,
    );
    expect(JSON.parse(signupMismatchReadUserMessage(base))).not.toHaveProperty('emailed');
  });
});
