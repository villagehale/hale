import { describe, expect, it } from 'vitest';
import { hasLinkShape } from '~/lib/format/link-shape';
import { kidNoticeTitle } from './calendar-notice-title';

describe('kidNoticeTitle: a calendar title is someone else’s words', () => {
  it('strips the link a stranger put in the title', () => {
    expect(kidNoticeTitle("Kids' soccer pickup moved, see evil.app/x")).toBe(
      "Kids' soccer pickup moved, see",
    );
  });

  it.each([
    ['a phone', "Kids' soccer pickup moved, call 555-0199"],
    ['a phone split by slashes', 'Call 555/0199/1234'],
    ['a phone split by underscores', '555_0199_123'],
    ['a phone spread across words', 'Swim: ring 555 then 01 then 99'],
    ['a phone in another script', 'Swim ٥٥٥٠١٩٩'],
    ['an (at) and (dot) address', 'Swim, write name(at)evil(dot)app'],
    ['a [dot] host', 'Swim, see evil [dot] app'],
    ['a [at] address', 'Swim, write name [at] evil'],
    ['a spelled-out address', 'Swim, write name at evil dot app'],
  ])('drops the whole title when it holds %s', (_name, raw) => {
    expect(kidNoticeTitle(raw)).toBe('');
  });

  it('keeps a title whose digits are a clock range, or whose "at" is a place (positive control)', () => {
    expect(kidNoticeTitle('Swim lesson 4:30-5:15')).toBe('Swim lesson 4:30-5:15');
    expect(kidNoticeTitle('Swim at the rec centre')).toBe('Swim at the rec centre');
    expect(kidNoticeTitle('Polka dot party')).toBe('Polka dot party');
  });

  it('strips an email address and keeps the rest', () => {
    expect(kidNoticeTitle('Swim, questions to coach@example.test')).toBe('Swim, questions to');
  });

  it('truncates first, so the cut cannot make a link', () => {
    // "evil.co9zz" is not a host (its ending holds a digit). Cut after "evil.co", it is one.
    const title = `${'x'.repeat(69)} evil.co9zz more words`;
    const out = kidNoticeTitle(title);
    expect(hasLinkShape(out)).toBe(false);
    expect(out).toBe('x'.repeat(69));
  });

  it('keeps a plain title, and bounds a long one (positive control)', () => {
    expect(kidNoticeTitle('  Swim   lesson ')).toBe('Swim lesson');
    expect(kidNoticeTitle(`Swim ${'a'.repeat(100)}`)).toHaveLength(80);
  });
});
