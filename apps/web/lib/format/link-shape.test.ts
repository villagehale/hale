import { describe, expect, it } from 'vitest';
import { hasLinkBeyond, hasLinkShape, linksOutside, withoutLinks } from './link-shape';

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
    ['a title-case ending', 'evil.Com'],
    ['a title-case name and ending', 'Abc.Com'],
    ['a capitalised short link with no path', 'Bit.Ly'],
    ['a short capitalised name', 'Go.Com'],
    ['a title-case app ending', 'visit evil.App'],
    ['a title-case ending mid-sentence', 'see evil.Com now'],
    ['a title-case ending after a crisis line', 'Call 988 or see crisis.Org'],
    ['a capitalised short link after a verb', 'visit Bit.Ly'],
    ['a title-case ending ending a sentence', 'see evil.App.'],
    ['a title-case ending after an ideographic full stop', 'see evil。App'],
    ['a glued sentence (fails closed)', 'Look at the page.Check it tonight.'],
    ['a saint, unspaced (fails closed)', 'The St.Mary pool is open.'],
    ['an honorific, unspaced (fails closed)', 'Ask Mr.Smith at the desk.'],
    ['an Arabic host', 'مثال.مصر'],
    ['a Hebrew host', 'דוגמה.ישראל'],
    ['a digit name with an Arabic ending', '123.مصر'],
    ['an ASCII dot between Chinese runs', '你好.我们明天见'],
    ['an ASCII dot after digits in Chinese (fails closed)', '请拨打988.你并不孤单。'],
    ['a Han name with a Latin ending', '例子。com'],
    ['an ideographic full stop with a path after it', '你好。我们/x'],
    ['a Latin and digit name before an ideographic full stop', 'see evil1。中国'],
    ['a Latin name before an ideographic full stop (fails closed)', '我是Hale。你住在哪里'],
  ])('refuses %s', (_label, text) => {
    expect(hasLinkShape(text)).toBe(true);
  });

  it.each([
    ['a saint, spaced', "Swim at St. Mary's on Saturday."],
    ['a clock time', 'Doors open at 10.30am.'],
    ['a.m.', 'It starts at 9 a.m. sharp.'],
    ['e.g.', 'Bring a snack, e.g. fruit.'],
    ['a country abbreviation', 'In the U.S. and Canada, it is free.'],
    ['a Spanish country abbreviation', 'En EE.UU., es gratis.'],
    ['a price', 'It costs $12.50 a week.'],
    ['a Chinese full stop after a number', '请拨打988。全天都有人接听。'],
    ['a Chinese full stop between sentences', '你好。我们明天见'],
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

describe('linksOutside: an allowed word counts only whole', () => {
  it('passes an allowed host or address standing as a word, any case or edge', () => {
    expect(linksOutside('See villagehale.com.', ['villagehale.com'])).toEqual([]);
    expect(linksOutside('(VillageHale.com)', ['villagehale.com'])).toEqual([]);
    expect(linksOutside('Write aloha@villagehale.com!', ['aloha@villagehale.com'])).toEqual([]);
    expect(linksOutside('St.Mary pool', ['The St.Mary pool'])).toEqual([]);
  });

  it.each([
    ['a host built around an allowed host', 'See evilvillagehale.com', ['villagehale.com']],
    ['a mailbox built around an allowed one', 'xaloha@villagehale.com', ['aloha@villagehale.com']],
    ['a host built on an allowed word', 'See kidsclub.evil.app', ['kidsclub']],
    ['a host cut out of an allowed one', 'See club.ca', ['kidsclub.ca']],
    [
      'a look-alike joined by a zero-width space',
      'See evil\u200Bvillagehale.com',
      ['villagehale.com'],
    ],
    ['a spaced-dot host', 'See bit . ly/x', []],
  ])('refuses %s', (_label, text, allowed) => {
    expect(linksOutside(text, allowed)).not.toEqual([]);
  });
});

describe('withoutLinks', () => {
  it('drops a link however it is written, read the way the shared check reads it', () => {
    for (const label of [
      'Swim https：//evil.app/x Tuesdays',
      'Swim https:／／evil.app Tuesdays',
      'Swim evil . app/x Tuesdays',
      'Swim evil [.] app Tuesdays',
    ]) {
      expect(withoutLinks(label), label).toBe('Swim Tuesdays');
    }
  });

  it('keeps a label with no link whole', () => {
    expect(withoutLinks('Swim Level 2, St. Mary pool, 10.30am')).toBe(
      'Swim Level 2, St. Mary pool, 10.30am',
    );
  });
});
