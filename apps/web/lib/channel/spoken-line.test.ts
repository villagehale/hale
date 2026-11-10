import { describe, expect, it } from 'vitest';
import { acceptSpokenLine } from './spoken-line';

describe('acceptSpokenLine: no link, phone or email it was not handed', () => {
  it.each([
    ['a link in the event name', "Leo's soccer pickup moved, see evil.app/x"],
    ['a bracketed link', "Leo's soccer moved, details at evil[.]app"],
    ['a phone', "Leo's soccer pickup moved, call 555-0199"],
    ['a spaced phone', "Leo's soccer pickup moved, call 5 5 5 0 1 9 9"],
    ['full-width digits', "Leo's soccer pickup moved, call ５５５－０１９９"],
    ['an email', "Leo's soccer moved, reply to coach@example"],
  ])('refuses %s', (_name, text) => {
    expect(acceptSpokenLine(text, [])).toBeNull();
    expect(acceptSpokenLine(text, undefined)).toBeNull();
  });

  it('passes a handed verbatim link and phone (positive control)', () => {
    const text = 'Connect it here: https://example.test/c - or call 1-800-555-0100.';
    expect(acceptSpokenLine(text, ['https://example.test/c', '1-800-555-0100'])).toBe(text);
  });

  it('passes short service numbers, which are not phones (positive control)', () => {
    expect(acceptSpokenLine('Text 988 any time, or call 811.', ['988'])).toBe(
      'Text 988 any time, or call 811.',
    );
  });

  it('still refuses a line missing a verbatim piece', () => {
    expect(acceptSpokenLine('Swim is cancelled.', ['https://example.test/c'])).toBeNull();
  });
});
