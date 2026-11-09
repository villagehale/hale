import { describe, expect, it } from 'vitest';
import { hasLinkShape } from '~/lib/format/link-shape';
import { kidNoticeTitle } from './calendar-notice-title';

describe('kidNoticeTitle: a calendar title is someone else’s words', () => {
  it('strips the link and the phone a stranger put in the title', () => {
    expect(kidNoticeTitle("Kids' soccer pickup moved, call 555-0199 or see evil.app/x")).toBe(
      "Kids' soccer pickup moved, call or see",
    );
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
