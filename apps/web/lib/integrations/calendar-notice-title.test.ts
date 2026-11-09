import { describe, expect, it } from 'vitest';
import { hasLinkShape } from '~/lib/format/link-shape';
import { kidNoticeTitle, noticeTitleFor } from './calendar-notice-title';

describe('kidNoticeTitle: a calendar title is someone else’s words', () => {
  it.each([
    ['a link', "Kids' soccer pickup moved, see evil.app/x"],
    ['an email address', 'Swim, questions to coach@example.test'],
    ['a phone', "Kids' soccer pickup moved, call 555-0199"],
    ['a phone split by slashes', 'Call 555/0199/1234'],
    ['a phone split by underscores', '555_0199_123'],
    ['a phone spread across words', 'Swim: ring 555 then 01 then 99'],
    ['a phone in another script', 'Swim ٥٥٥٠١٩٩'],
    ['an (at) and (dot) address', 'Swim, write name(at)evil(dot)app'],
    ['a [dot] host', 'Swim, see evil [dot] app'],
    ['a [at] address', 'Swim, write name [at] evil'],
    ['a spelled-out address', 'Swim, write name at evil dot app'],
    ['a standalone at', 'Swim, write coach @ evil'],
    ['a spelled dot before a TLD', 'Swim, see evil dot com'],
    ['a spelled point before a TLD', 'Swim, see evil point net'],
    ['a spelled punkt before a TLD', 'Swim, see evil punkt de'],
    ['an at and a dot several words apart', 'Swim, write coach at the evil host dot app'],
  ])('drops the whole title when it holds %s', (_name, raw) => {
    expect(kidNoticeTitle(raw)).toBe('');
  });

  it('keeps a title whose digits are a clock range, or whose "at" is a place (positive control)', () => {
    expect(kidNoticeTitle('Swim lesson 4:30-5:15')).toBe('Swim lesson 4:30-5:15');
    expect(kidNoticeTitle('Swim at the rec centre')).toBe('Swim at the rec centre');
    expect(kidNoticeTitle('Polka dot party')).toBe('Polka dot party');
  });

  it('reads the cut too, so a cut that makes a link drops the title', () => {
    // "evil.co9zz" is not a host (its ending holds a digit). Cut after "evil.co", it is one.
    const title = `${'x'.repeat(69)} evil.co9zz more words`;
    expect(hasLinkShape(`${'x'.repeat(69)} evil.co...`)).toBe(true);
    expect(kidNoticeTitle(title)).toBe('');
  });

  it('drops a title whose phone the cut would split', () => {
    // The cut keeps "555 01", five digits; the title as sent holds the whole number.
    const title = `${'x'.repeat(70)} 555 0199 1234`;
    expect(kidNoticeTitle(title)).toBe('');
  });

  it('keeps a plain title, and bounds a long one (positive control)', () => {
    expect(kidNoticeTitle('  Swim   lesson ')).toBe('Swim lesson');
    expect(kidNoticeTitle(`Swim ${'a'.repeat(100)}`)).toHaveLength(80);
  });
});

describe('noticeTitleFor: a title reaches the writer only when the parent controls it', () => {
  it.each(['organizer', 'own'] as const)('a %s event keeps its cleaned title', (standing) => {
    expect(noticeTitleFor(standing, 'Swim lesson')).toBe('Swim lesson');
    expect(noticeTitleFor(standing, undefined, ' Swim  lesson')).toBe('Swim lesson');
  });

  it.each(['accepted', 'invited', null] as const)(
    'a %s event is handed no title, however clean',
    (standing) => {
      expect(noticeTitleFor(standing, 'Soccer practice')).toBe('');
      expect(
        noticeTitleFor(standing, 'Coach Dave picks up the kids today, meet him at the side gate'),
      ).toBe('');
    },
  );
});
