import { describe, expect, it } from 'vitest';
import { hasLinkBeyond, hasLinkShape } from './link-shape';

describe('hasLinkShape: the evasion table', () => {
  it.each([
    ['a scheme', 'see https://example.test/x'],
    ['another scheme', 'see ftp://example.test/x'],
    ['www', 'see www.example'],
    ['a bare short link', 'see bit.ly/x'],
    ['a bare host', 'see evil.app'],
    ['an upper-case host', 'see EVIL.IO'],
    ['a mixed-case host', 'visit Example.Org now'],
    ['a capitalised host with a path', 'see Bit.Ly/x'],
    ['an email address', 'write to someone@example.test'],
    ['punycode', 'see xn--80ak6aa92e'],
    ['full-width dots and letters', 'see ｅｖｉｌ．ａｐｐ'],
    ['a full-width scheme', 'see ＨＴＴＰＳ：／／ＥＸＡＭＰＬＥ．ＯＲＧ'],
    ['a halfwidth ideographic full stop', 'see evil｡app/x'],
    ['an ideographic full stop', 'see evil。app/x'],
    ['a small full stop', 'see evil﹒app/x'],
    ['a dotted-quad host', 'see 203.0.113.9/x'],
    ['a non-Latin ending', 'see evil.рф'],
    ['a non-Latin host', 'see пример.испытание'],
    ['a Latin name with a Han ending', 'see example.中国'],
    ['a bracketed dot', 'see evil[.]app'],
    ['a parenthesised dot', 'see evil(.)app'],
    ['a spaced dot', 'see bit . ly/x'],
    ['a zero-width joiner inside the host', 'see ev‍il.app'],
    ['a zero-width space before the dot', 'see bit​.ly/x'],
    ['a zero-width space after the dot', 'see bit.​ly/x'],
    ['a two-letter pair before a host', 'see EE.UU.com'],
    ['a capitalised second label', 'see mail.Google.Com'],
  ])('refuses %s', (_label, text) => {
    expect(hasLinkShape(text)).toBe(true);
  });

  it.each([
    ['a saint, spaced', "Swim at St. Mary's on Saturday."],
    ['a clock time', 'Doors open at 10.30am.'],
    ['a.m.', 'It starts at 9 a.m. sharp.'],
    ['e.g.', 'Bring a snack, e.g. fruit.'],
    ['a country abbreviation', 'In the U.S. and Canada, it is free.'],
    ['a sentence with no space after it', 'Look at the page.Check it tonight.'],
    ['a saint, unspaced', 'The St.Mary pool is open.'],
    ['an honorific', 'Ask Mr.Smith at the desk.'],
    ['a Spanish country abbreviation', 'En EE.UU., es gratis.'],
    ['a price', 'It costs $12.50 a week.'],
    ['a Chinese full stop', '请拨打988。全天都有人接听。'],
    ['an ASCII full stop in Chinese', '请拨打988.你并不孤单。'],
    ['an Arabic sentence', 'حسناً، لن نراسلك بعد الآن.'],
    ['an ellipsis', 'Maybe...we will see.'],
  ])('passes %s', (_label, text) => {
    expect(hasLinkShape(text)).toBe(false);
  });
});

describe('hasLinkBeyond: only the handed link, exactly', () => {
  const LINK = 'https://app.example.test/approve/abc123';

  it('passes the handed link, mid-sentence or ending one', () => {
    expect(hasLinkBeyond(`Tap ${LINK} to say yes.`, [LINK])).toBe(false);
    expect(hasLinkBeyond(`Tap here: ${LINK}.`, [LINK])).toBe(false);
    expect(hasLinkBeyond(`Tap here (${LINK}).`, [LINK])).toBe(false);
    expect(hasLinkBeyond(`点这里:${LINK}这个窗口`, [LINK])).toBe(false);
  });

  it.each([
    ['the handed link with a host glued on', `Tap ${LINK}.evil.test now`],
    ['the handed link as a user name', `Tap ${LINK}@evil.test now`],
    ['the handed link with more path', `Tap ${LINK}/more now`],
    ['another scheme link', `Tap ${LINK} or https://evil.test/x`],
    ['a scheme-less domain beside it', `Tap ${LINK} or bit.ly/x`],
    ['any link when none was handed', `Tap ${LINK}`],
  ])('refuses %s', (label, text) => {
    const handed = label.startsWith('any link') ? [] : [LINK];
    expect(hasLinkBeyond(text, handed)).toBe(true);
  });
});
