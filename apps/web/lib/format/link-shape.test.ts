import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  asHandsetReads,
  draftCarriesLink,
  foreignLinks,
  hasLinkBeyond,
  hasLinkShape,
  linkAttemptKind,
  linkHostname,
  linksOutside,
  noteLinkGate,
  sharedLinkCheckEnabled,
  withoutLinks,
  wordSpans,
} from './link-shape';

const EVASIONS: readonly (readonly [string, string])[] = [
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
  ['a Latin name with a Han ending after an ideographic full stop', 'evil。在线'],
  ['a Latin name with a Han ending after a dot', 'evil.在线'],
  ['a Han name with a Han ending', '例子。在线'],
  ['a mixed name with a Han ending', '请到Hale报名。在线'],
  ['a Han ending glued to more letters', 'evil。在线abc'],
  ['a Latin word before a dot and a Han run (fails closed)', '早上7:00 AM.到时候需要你自己去报名'],
  ['a Katakana ending with a long-vowel mark', 'evil。セール'],
  ['another Katakana ending with a long-vowel mark', 'evil。グーグル'],
  ['a Katakana ending with no long-vowel mark', 'evil。ファッション'],
  ['a Han ending that starts a longer run', 'evil。在线报名'],
  ['a Han ending that starts a longer run inside a sentence', '请访问evil。在线报名吧'],
  ['a one-dot leader', 'see evil\u2024app'],
  ['a non-http scheme', 'see git://evil.test/x'],
  ['a mailto address', 'write mailto:a@evil.app'],
  ['a Han name and the China ending', '例子。中国'],
  ['digits and the China ending', '123。中国'],
];

const STRICTER: readonly (readonly [string, string])[] = [
  ['a middle dot', 'see evil\u00B7app'],
  ['a hyphenation point', 'see evil\u2027app'],
  ['a katakana middle dot', 'see evil\u30FBapp'],
  ['localhost with a port and a path', 'open localhost:3000/x'],
  ['a space before the dot', 'see evil .app'],
  ['a space after the dot', 'see evil. app'],
  ['a digit standing in for a letter', 'see evil.c0m'],
  ['a scheme with no slashes', 'see javascript:alert(1)'],
];

describe('hasLinkShape: the evasion table', () => {
  it.each(EVASIONS)('refuses %s', (_label, text) => {
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
    // A Han run after the stop is an ending only when the root zone delegates it.
    [
      'a Latin word before a Chinese full stop',
      '开放:Monday, January 12 at 7:00 AM。到时候需要你自己去报名,',
    ],
    ['a Latin word before a Chinese full stop, then prose', 'AM。到时候需要你自己去报名'],
    ['a Japanese full stop before Katakana prose', 'はい。コーヒーを飲みます'],
    ["Hale's name before a Chinese full stop", '我是Hale。你住在哪里'],
    ["Hale's name inside the run before a Chinese full stop", 'Hale这边不会代办。报名页面在这里'],
    ['an Arabic sentence', 'حسناً، لن نراسلك بعد الآن.'],
    ['an ellipsis', 'Maybe...we will see.'],
  ])('passes %s', (_label, text) => {
    expect(hasLinkShape(text)).toBe(false);
  });
});

describe('SHARED_LINK_CHECK_ENABLED: the stricter shapes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is on only for exactly true', () => {
    expect(sharedLinkCheckEnabled({})).toBe(false);
    expect(sharedLinkCheckEnabled({ SHARED_LINK_CHECK_ENABLED: 'true' })).toBe(true);
    for (const value of ['TRUE', '1', 'true\n', ' true', 'on', '']) {
      expect(sharedLinkCheckEnabled({ SHARED_LINK_CHECK_ENABLED: value })).toBe(false);
    }
  });

  it.each(STRICTER)('passes %s while the flag is off', (_label, text) => {
    expect(hasLinkShape(text)).toBe(false);
  });

  it.each(STRICTER)('refuses %s when the flag is on', (_label, text) => {
    vi.stubEnv('SHARED_LINK_CHECK_ENABLED', 'true');
    expect(hasLinkShape(text)).toBe(true);
  });

  it.each([
    ['a saint, spaced', "Swim at St. Mary's on Saturday."],
    ['a clock time', 'Doors open at 10.30am.'],
    ['a.m.', 'It starts at 9 a.m. sharp.'],
    ['e.g.', 'Bring a snack, e.g. fruit.'],
    ['an honorific, spaced', 'Ask Mr. Smith at the desk.'],
    ['a middle dot before digits', 'Sat 10am \u00B7 123 King St'],
    ['a price', 'It costs $12.50 a week.'],
    ['a dotted clock', 'Starts at 9.45.'],
    ['a crisis line, then a sentence', 'Call 988. You are not alone.'],
    ['a sentence starting with a delegated word', 'Done. It is open. Now we wait.'],
  ])('still passes %s when the flag is on', (_label, text) => {
    vi.stubEnv('SHARED_LINK_CHECK_ENABLED', 'true');
    expect(hasLinkShape(text)).toBe(false);
  });
});

describe('link gate log', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('records the gate and the kind, and never the draft', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    noteLinkGate('holding-line', 'redraft');
    expect(info).toHaveBeenCalledWith({ kind: 'redraft', gate: 'holding-line' }, 'link gate');
    const payload = JSON.stringify(info.mock.calls);
    expect(payload).not.toMatch(/http|evil|bit\.ly/i);
  });

  it('calls the last attempt a refusal and an earlier one a redraft', () => {
    expect(linkAttemptKind(1, 2)).toBe('redraft');
    expect(linkAttemptKind(2, 2)).toBe('refused');
  });

  it('logs a hit and stays quiet when the draft has no link', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(draftCarriesLink('see evil.app', 'spots', 'refused')).toBe(true);
    expect(info).toHaveBeenCalledWith({ kind: 'refused', gate: 'spots' }, 'link gate');
    info.mockClear();
    expect(draftCarriesLink("Swim at St. Mary's.", 'spots', 'refused')).toBe(false);
    expect(info).not.toHaveBeenCalled();
  });
});

describe.each([
  ['a path link', 'https://app.example.test/approve/abc123'],
  ['a host-only link', 'https://app.example.test'],
])('hasLinkBeyond and foreignLinks: only the handed link, exactly, for %s', (_kind, LINK) => {
  it('passes the handed link, mid-sentence or ending one', () => {
    for (const text of [
      `Tap ${LINK} to say yes.`,
      `Tap here: ${LINK}.`,
      `Tap here (${LINK}).`,
      `点这里:${LINK}这个窗口`,
      `报名页面在这里:${LINK}(场次:周六上午9:30)。`,
      `报名页面在这里:${LINK}（场次）`,
      `报名页面在这里:${LINK}。到时候`,
      `报名页面在这里:${LINK}（场次`,
      `报名页面在这里(${LINK}）。`,
      `[${LINK}]`,
      `Tap ${LINK}!`,
      `"${LINK}", then reply`,
      `The registration page is ${LINK}. Max's age fits the band.`,
      `The page is ${LINK}! Mia is just outside it.`,
    ]) {
      expect(hasLinkBeyond(text, [LINK])).toBe(false);
      expect(foreignLinks(text, { handed: [LINK], email: null, words: [] })).toEqual([]);
    }
  });

  it.each([
    ['the handed link with a host glued on', `Tap ${LINK}.evil.test now`],
    ['the handed link as a user name', `Tap ${LINK}@evil.test now`],
    ['the handed link with more path', `Tap ${LINK}/more now`],
    ['the handed link with a full-width dot and more', `Tap ${LINK}．app now`],
    ['the handed link with a port', `Tap ${LINK}:8080 now`],
    ['the handed link with a query', `Tap ${LINK}?next=x now`],
    ['the handed link, a bracket, then a host', `Tap ${LINK}(evil.app)`],
    ['the handed link, a bang, then a user-info host', `Tap ${LINK}!@evil now`],
    ['the handed link, a quote, then a user-info host', `Tap ${LINK}'@evil now`],
    ['the handed link, a comma, then more host', `Tap ${LINK},evil now`],
    ['the handed link, a backslash, then a user-info host', `Tap ${LINK}\\@evil.app now`],
    ['the handed link as a single-label user name', `Tap ${LINK}@evil now`],
    ['the handed link, an escaped slash, then a user-info host', `Tap ${LINK}%2F@evil.app now`],
    ['the handed link with a dotted host glued on', `Tap ${LINK}.evil.tld now`],
    ['another scheme link', `Tap ${LINK} or https://evil.test/x`],
    ['a scheme-less domain beside it', `Tap ${LINK} or bit.ly/x`],
    ['a spaced-dot host after the handed link', `Tap ${LINK}. Then evil . app now`],
    ['the handed link, a full stop, then a non-ASCII label', `Tap ${LINK}.рф now`],
    ['the handed link, a full stop, then an accented word', `Tap ${LINK}.Évite now`],
    ['any link when none was handed', `Tap ${LINK}`],
  ])('refuses %s', (label, text) => {
    const handed = label.startsWith('any link') ? [] : [LINK];
    expect(hasLinkBeyond(text, handed)).toBe(true);
    expect(foreignLinks(text, { handed, email: null, words: [] })).not.toEqual([]);
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

describe('linkHostname: the host the browser parser reads, or null', () => {
  it.each([
    ['a query that carries another scheme', 'evil.app/x?r=https://villagehale.com', 'evil.app'],
    ['a port before the path', 'villagehale.com:443/x', 'villagehale.com'],
    ['a scheme-less host', 'Evil.App/slip', 'evil.app'],
    ['a host and a query', 'https://villagehale.com/x?y=1', 'villagehale.com'],
  ])('%s', (_label, word, host) => {
    expect(linkHostname(word)).toBe(host);
  });

  it.each([
    ['a user part, whose host a reader mistakes', 'https://villagehale.com:443@evil.app/login'],
    ['an address', 'parents@evil.app'],
    ['a word the parser refuses', 'go:https://evil.app'],
    ['a backslash, which the parser reads as a slash', 'https://evil.app\\@villagehale.com'],
    ['a backslash before a host the reader sees', 'http://villagehale.com\\@evil.app'],
  ])('null for %s', (_label, word) => {
    expect(linkHostname(word)).toBeNull();
  });
});

describe('wordSpans: the shared word reading, with where each word sits', () => {
  it('drops the prose edges and points at the word in the reading', () => {
    const read = asHandsetReads('See (evil [。] example), then 9:00.');
    const spans = wordSpans(read);
    expect(spans.map((span) => span.word)).toEqual(['See', 'evil.example', 'then', '9:00']);
    for (const span of spans) expect(read.slice(span.from, span.to)).toBe(span.word);
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

describe("foreignLinks: words from Hale's own records are not links", () => {
  const LINK = 'https://register.example.test/activity/42';
  const FAMILY = { handed: [LINK], email: 'sam@example.test', words: ['Sam', 'Ana', 'Lena'] };

  it.each(EVASIONS)('still refuses %s, and names it', (_label, text) => {
    expect(foreignLinks(text, FAMILY)).not.toEqual([]);
  });

  it('passes the zh-rush-timed-open first draft: the handed link, then a bracket', () => {
    const draft = `这个报名要等到指定时间才开放:周一(1月12日)早上7:00。到时候需要你自己去报名,Hale这边不会代办。报名页面在这里:${LINK}(场次:周六上午9:30)。为了到时候能快点填完,可以提前备好这些信息:孩子名字 Lena,孩子姓氏 Ferreira,家长名字 Sam,家长邮箱 sam@example.test。`;
    expect(foreignLinks(draft, FAMILY)).toEqual([]);
    expect(foreignLinks(draft, { ...FAMILY, handed: [] })).not.toEqual([]);
  });

  it("passes the parent's email from the facts, and the same shape from anywhere else is a link", () => {
    const draft = `Sign up here: ${LINK}. Have ready: parent email sam@example.test.`;
    expect(foreignLinks(draft, FAMILY)).toEqual([]);
    expect(foreignLinks(draft, { handed: [LINK], email: null, words: [] })).toEqual([
      'sam@example.test',
    ]);
    expect(foreignLinks('家长邮箱:sam@example.test。', FAMILY)).toEqual([]);
    expect(foreignLinks('write evilsam@example.test', FAMILY)).toEqual(['evilsam@example.test']);
    expect(foreignLinks('write sam@example.test.evil.app', FAMILY)).toEqual([
      'sam@example.test.evil.app',
    ]);
  });

  it('never trusts a name that is itself link-shaped, nor an email outside its own field', () => {
    for (const name of ['evil.app', 'Evil.App', 'evil。app', 'bit.ly/x', 'x@evil.test']) {
      expect(
        foreignLinks(`Ana and ${name} have not added it yet.`, { ...FAMILY, words: ['Ana', name] }),
      ).not.toEqual([]);
    }
    expect(
      foreignLinks('Ana and Rosa have not added it yet.', { ...FAMILY, words: ['Ana', 'Rosa'] }),
    ).toEqual([]);
    expect(
      foreignLinks('write sam@example.test', {
        handed: [],
        email: null,
        words: ['sam@example.test'],
      }),
    ).toEqual(['sam@example.test']);
  });

  it('reads a full stop before a trusted name as the end of a Chinese sentence', () => {
    expect(foreignLinks('已经放到日历上。Ana、Sam,还没有。', FAMILY)).toEqual([]);
    expect(foreignLinks('没有空位了。Hale不会自动加入候补', FAMILY)).toEqual([]);
    expect(foreignLinks('Hale这边不会代办。报名页面在这里', FAMILY)).toEqual([]);
    expect(
      foreignLinks('已经放到日历上。Ana、Sam,还没有。', { handed: [], email: null, words: [] }),
    ).not.toEqual([]);
  });

  it.each([
    ['an untrusted Latin ending', '例子。app'],
    ['a Latin name before the stop', 'evil。app'],
    ['a trusted name before the stop, not after', 'Ana。app'],
    ['a trusted name followed by a host', '日历上。Ana.app'],
    ['a trusted name glued to more letters', '日历上。Anax'],
    ['a trusted name with a path', '日历上。Ana/x'],
  ])('still refuses %s', (_label, text) => {
    expect(foreignLinks(text, FAMILY)).not.toEqual([]);
  });

  it('never reads a full stop before a trusted name that is a delegated ending as a sentence end', () => {
    expect(foreignLinks('详情见例子。Ai', { ...FAMILY, words: ['Ai'] })).toEqual(['详情见例子.Ai']);
    expect(foreignLinks('详情见例子。Ana', { ...FAMILY, words: ['Ana'] })).toEqual([]);
  });

  it("trusts no member's name inside the run before the stop", () => {
    expect(foreignLinks('请到Evil报名。在线', { ...FAMILY, words: ['Evil'] })).not.toEqual([]);
    expect(foreignLinks('请到Evil报名。我们', { ...FAMILY, words: ['Evil'] })).toEqual([]);
  });

  it('names exactly the offending words', () => {
    expect(foreignLinks(`Tap ${LINK} or bit.ly/x, Sam`, FAMILY)).toEqual(['bit.ly/x']);
  });

  it('names only the host a phone would make inside unspaced CJK writing', () => {
    expect(foreignLinks('早上7:00 AM.到时候需要你自己去报名,Hale这边不会代办', FAMILY)).toEqual([
      'AM.到时候需要你自己去报名',
    ]);
    expect(foreignLinks('报名页面在这里:evil.app/x,到时候', FAMILY)).toEqual(['evil.app']);
    expect(foreignLinks('看这里https://evil.test/x好吗', FAMILY)).toEqual([
      '看这里https://evil.test/x好吗',
    ]);
  });
});
