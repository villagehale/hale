import { describe, expect, it } from 'vitest';
import { LIVE_VIEW_LINK_WITHHELD, liveViewUrl, withoutLiveViewLinks } from './live-view';

const TOKEN = 'fixture-live-view-token';
const LIVE = `https://live.browser-use.com/s/${TOKEN}`;
const REC = 'https://register.example-rec.test/activity/42';

describe('liveViewUrl', () => {
  it('keeps an https link on the Browser Use live-view host', () => {
    expect(liveViewUrl(LIVE)).toBe(LIVE);
  });

  it.each([
    ['another https host', 'https://live.example.test/s/abc'],
    ['a look-alike suffix', 'https://live.browser-use.com.example.test/s/abc'],
    ['a look-alike prefix', 'https://evil-live.browser-use.com/s/abc'],
    ['a sibling Browser Use host', 'https://cdp.browser-use.com/s/abc'],
    ['plain http on the right host', 'http://live.browser-use.com/s/abc'],
    ['credentials before the host', 'https://live.browser-use.com@example.test/s/abc'],
    ['not a URL', 'live view'],
    ['not a string', 42],
  ])('refuses %s', (_label, value) => {
    expect(liveViewUrl(value)).toBeNull();
  });
});

// Each form below passes the host pin: the URL parser maps it to the live-view host.
const PIN_ACCEPTED_FORMS = [
  ['a fullwidth host', `https://\uFF4C\uFF49\uFF56\uFF45.browser-use.com/s/${TOKEN}`],
  ['a percent-encoded dot', `https://live%2Ebrowser-use.com/s/${TOKEN}`],
  ['a tab inside the host', `https://live.brow\tser-use.com/s/${TOKEN}`],
  ['a newline inside the host', `https://live.brow\nser-use.com/s/${TOKEN}`],
  ['backslash separators', `https:\\\\live.browser-use.com\\s\\${TOKEN}`],
  ['a zero-width space in the host', `https://live.\u200Bbrowser-use.com/s/${TOKEN}`],
  ['an ideographic full stop', `https://live\u3002browser-use.com/s/${TOKEN}`],
  ['percent-encoded letters', `https://%6C%69ve.browser-use.com/s/${TOKEN}`],
  ['a variation selector in the host', `https://live.b\uFE0Frowser-use.com/s/${TOKEN}`],
] as const;

describe('a pin-accepted link never reaches history with its token', () => {
  it.each(PIN_ACCEPTED_FORMS)('%s comes back canonical and is redacted', (_label, form) => {
    const pinned = liveViewUrl(form);
    expect(pinned).toBe(LIVE);
    const stored = withoutLiveViewLinks(`Finish here: ${pinned}`);
    expect(stored).not.toContain(TOKEN);
    expect(stored).toContain(LIVE_VIEW_LINK_WITHHELD);
  });
});

describe('withoutLiveViewLinks', () => {
  it.each(PIN_ACCEPTED_FORMS)('removes %s written straight into the text', (_label, form) => {
    const stored = withoutLiveViewLinks(`Finish here: ${form}`);
    expect(stored).not.toContain(TOKEN);
    expect(stored).toContain(LIVE_VIEW_LINK_WITHHELD);
  });

  it.each([
    ['the exact link', `Finish here: ${LIVE}`],
    ['an upper-case host', `Finish here: HTTPS://LIVE.BROWSER-USE.COM/s/${TOKEN}`],
    ['no scheme', `Finish here: live.browser-use.com/s/${TOKEN}`],
    ['a query-string token', `Finish here: https://live.browser-use.com/?wss=${TOKEN}&ui=false`],
    ['angle brackets', `Finish here: <${LIVE}>.`],
    ['CJK text right after the link', `点这里:${LIVE}这个窗口大约保留5分钟`],
  ])('removes %s', (_label, text) => {
    const stored = withoutLiveViewLinks(text);
    expect(stored).not.toContain(TOKEN);
    expect(stored.toLowerCase()).not.toContain('live.browser-use.com');
    expect(stored).toContain(LIVE_VIEW_LINK_WITHHELD);
  });

  it('keeps the words around the link', () => {
    expect(withoutLiveViewLinks(`点这里:${LIVE}这个窗口大约保留5分钟`)).toBe(
      `点这里:${LIVE_VIEW_LINK_WITHHELD}这个窗口大约保留5分钟`,
    );
  });

  it('leaves a text with no live-view link exactly as it was', () => {
    const text = `Sign up on their page:\n\t${REC}?q=a%2Eb （ｆｕｌｌｗｉｄｔｈ） a\u200Bb C:\\path (browser-use.com is not in this one)`;
    expect(withoutLiveViewLinks(text)).toBe(text);
  });
});
