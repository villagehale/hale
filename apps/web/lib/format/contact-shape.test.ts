import { describe, expect, it } from 'vitest';
import { contactsOutside, withoutContacts } from './contact-shape';
import { hasLinkShape } from './link-shape';

describe('contactsOutside: the evasion table', () => {
  it.each([
    ['a bare host', 'Soccer moved, see evil.app/x', 'link'],
    ['a bracketed dot', 'Soccer moved, see evil[.]app', 'link'],
    ['a spaced dot', 'Soccer moved, see bit . ly/x', 'link'],
    ['a full-width scheme and colon', 'see ＨＴＴＰＳ：／／ＥＸＡＭＰＬＥ．ＯＲＧ', 'link'],
    ['a dashed local number', 'Pickup moved, call 555-0199', 'phone'],
    ['a dotted number', 'Pickup moved, call 202.555.0143', 'phone'],
    ['a bracketed area code', 'Pickup moved, call (202) 555-0143', 'phone'],
    ['an international number', 'Pickup moved, call +1 202 555 0143', 'phone'],
    ['a spaced number', 'Pickup moved, call 5 5 5 0 1 9 9', 'phone'],
    ['full-width digits', 'Pickup moved, call ５５５－０１９９', 'phone'],
    ['an en-dash', 'Pickup moved, call 555–0199', 'phone'],
    ['a zero-width space inside', 'Pickup moved, call 555​0199', 'phone'],
    ['digits of another script', 'Pickup moved, call ٥٥٥-٠١٩٩', 'phone'],
    ['an email with no dot after the at', 'write to coach@localhost', 'email'],
    ['a full-width at', 'write to coach＠example', 'email'],
  ])('refuses %s', (_name, text, kind) => {
    expect(contactsOutside(text, [])).toContain(kind);
  });

  it.each([
    ['a crisis line', 'If you are not safe, text 988 any time.'],
    ['a health line', 'Call 811 to register with a family doctor.'],
    ['an emergency number', 'In an emergency, call 911.'],
    ['a clock range', 'Swim moved to Sat, Sep 19 10:00-10:45.'],
    ['a date', 'Piano moved from 11/08 to 11/09 at 4:30.'],
    ['a count and a time', 'Three sessions of soccer are off, the first Tue 17:00.'],
    ['an at with spaces', 'Picnic @ the park moved to Sunday.'],
    ['plain prose with an abbreviation', 'St. Mary pool moved to 9 a.m. on Sat.'],
  ])('passes %s (positive control)', (_name, text) => {
    expect(contactsOutside(text, [])).toEqual([]);
  });

  it('passes a link, a phone and an email only when a verbatim piece handed them', () => {
    const line =
      'Connect here: https://example.test/c - or call 1-800-555-0100, or hello@example.test';
    const handed = ['https://example.test/c', 'call 1-800-555-0100', 'hello@example.test'];
    expect(contactsOutside(line, handed)).toEqual([]);
    expect(contactsOutside(line, [])).toEqual(['link', 'phone', 'email']);
  });

  it('a phone built around a handed number is another phone', () => {
    expect(contactsOutside('Text 988 555 0199', ['Text 988'])).toEqual(['phone']);
    expect(contactsOutside('Call 1-800-555-01000', ['1-800-555-0100'])).toEqual(['phone']);
  });

  it('a host built around a handed word is another link', () => {
    expect(contactsOutside('see evilexample.test', ['example.test'])).toEqual(['link']);
  });
});

describe('withoutContacts', () => {
  it('strips the link, phone and email words and keeps the rest', () => {
    expect(
      withoutContacts("Kids' soccer pickup moved, call 555-0199 or see evil.app/x or a@b.example"),
    ).toBe("Kids' soccer pickup moved, call or see or");
  });

  it('leaves nothing when what is left still reads as a link', () => {
    // Each word alone is clean; together they close into "evil.app".
    expect(withoutContacts('Swim evil . app')).toBe('');
  });

  it('keeps a plain title whole (positive control)', () => {
    expect(withoutContacts('Swim lesson, 10:00-10:45 @ the pool')).toBe(
      'Swim lesson, 10:00-10:45 @ the pool',
    );
  });

  it('a stripped title has no link shape left', () => {
    const out = withoutContacts('Recital ｅｖｉｌ．ａｐｐ evil(.)app www.example');
    expect(out).toBe('Recital');
    expect(hasLinkShape(out)).toBe(false);
  });
});
