import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { encode } from 'uqr';
import { describe, expect, it, vi } from 'vitest';
import { SiteFooter } from '~/components/site-footer.js';
import { SiteHeader } from '~/components/site-header.js';
import { localeHref } from '~/i18n/navigation.js';
import type { Locale } from '~/i18n/routing.js';
import { intakePrefill } from '~/lib/intake-prefill.js';
import { primaryTextTarget } from '~/lib/primary-cta.js';
import { chromeCta } from '~/lib/site/chrome-cta.js';
import { buildSmsBody, buildSmsHref } from '~/lib/text-entry.js';
import sitemap from '../../sitemap.js';
import TextPage, { generateMetadata } from './page.js';

const meta = () => generateMetadata({ params: Promise.resolve({ locale: 'en' as const }) });

/** Locked Hale #1, the old SMS hello. The live page must not render it. */
const LOCKED_PREVIEW_EN =
  'Hi — I’m Hale. I help plan your kids’ year — what’s on near them, sign-up mornings, and how it went. Names, ages, and postal code and I’ll look up what’s coming.';

/**
 * /text is the chooser (F14): the QR cards' destination AND the header pill's —
 * but still a handoff, not a page to rank. No sitemap row, noindex, and no
 * footer link; while the number is dark nothing points at it at all. These are
 * the structural guards. The locked greeting below is a negative pin: the live
 * page must not render that old hello.
 */

describe('/text (unlisted entry surface)', () => {
  it('is noindex, nofollow', async () => {
    expect((await meta()).robots).toEqual({ index: false, follow: false });
  });

  it('claims its own canonical rather than inheriting the homepage’s', async () => {
    expect((await meta()).alternates?.canonical).toBe('/text');
  });

  it('is absent from the sitemap', () => {
    for (const entry of sitemap()) {
      expect(entry.url.endsWith('/text')).toBe(false);
    }
  });

  it('is the header pill’s destination — and stays out of the footer', () => {
    // F14 chooser: the chrome's one primary CTA opens this page (it is the
    // universal target that works on every device). The pill only exists while
    // the number is live; dark, the chrome degrades to email and nothing may
    // point here. The footer never links it — it is a handoff, not navigation.
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');
    const header = renderToStaticMarkup(createElement(SiteHeader));
    expect(header).toContain('href="/text"');
    vi.unstubAllEnvs();
    const darkHeader = renderToStaticMarkup(createElement(SiteHeader));
    expect(darkHeader).not.toContain('/text');
    expect(renderToStaticMarkup(createElement(SiteFooter))).not.toContain('/text');
  });

  it('wears the shared header and footer in en, fr, and zh — turtle lockup included', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');
    for (const locale of ['en', 'fr', 'zh'] as const satisfies readonly Locale[]) {
      const html = renderToStaticMarkup(
        await TextPage({
          params: Promise.resolve({ locale }),
          searchParams: Promise.resolve({}),
        }),
      );
      const header = chrome(html, 'header');
      const footer = chrome(html, 'footer');
      expect(header, `${locale} forked the header`).toBe(
        chrome(renderToStaticMarkup(createElement(SiteHeader, { locale })), 'header'),
      );
      expect(footer, `${locale} forked the footer`).toBe(
        chrome(
          renderToStaticMarkup(createElement(SiteFooter, { locale, omitPrivacyLink: true })),
          'footer',
        ),
      );
      // One privacy-policy link on the rendered page, and it is the column's
      // Canada line — not a second copy in the footer.
      const privacyHref = localeHref(locale, '/privacy');
      const privacyAt = html.indexOf(`href="${privacyHref}"`);
      expect(privacyAt, `${locale} missing the column privacy link`).toBeGreaterThan(-1);
      expect(html.indexOf(`href="${privacyHref}"`, privacyAt + 1)).toBe(-1);
      expect(privacyAt).toBeLessThan(html.indexOf('<footer'));
      expect(footer).not.toContain(`href="${privacyHref}"`);
      // The shared bar is the glass pill, and the lockup is the turtle tile
      // beside the drawn wordmark — the same assets the landing header uses.
      expect(header).toContain('class="v4-nav v4-glass"');
      expect(header).toContain('hale-logo');
      expect(header).toContain('viewBox="0 0 905.840370 590.701960"');
      // The column is the conversion door. Each locale shows the message the
      // parent will send, and Hale's design reply — not the retired preview.
      if (locale === 'fr') {
        expect(html).toContain('Salut Hale, qu&#x27;est-ce qui se passe?');
        expect(html).not.toContain('qu\u2019est-ce qui se passe ?');
      } else if (locale === 'zh') {
        expect(html).toContain('嘿 Hale，最近怎么样？');
      } else {
        expect(html).toContain('Hey Hale, what&#x27;s going on?');
      }
    }
    const en = renderToStaticMarkup(
      await TextPage({
        params: Promise.resolve({ locale: 'en' }),
        searchParams: Promise.resolve({}),
      }),
    );
    const fr = renderToStaticMarkup(
      await TextPage({
        params: Promise.resolve({ locale: 'fr' }),
        searchParams: Promise.resolve({}),
      }),
    );
    const zh = renderToStaticMarkup(
      await TextPage({
        params: Promise.resolve({ locale: 'zh' }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(en).toContain(
      'Hey, it&#x27;s Hale. I find what&#x27;s on for kids near you. What&#x27;s your postal code? I&#x27;ll show you what&#x27;s on this week.',
    );
    expect(en).not.toContain(LOCKED_PREVIEW_EN);
    expect(zh).toContain('嘿，我是 Hale。我帮你找附近孩子能参加的。');
    expect(zh).not.toContain(LOCKED_PREVIEW_EN);
    expect(zh).not.toContain('已报名');
    expect(fr).toContain(
      'Salut, c’est Hale. Je trouve ce qui se passe pour les enfants près de chez toi.',
    );
    vi.unstubAllEnvs();
  });

  it('when the ladder flag is exactly on, the preview is the postal-code first message', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');
    vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', 'on');
    const html = renderToStaticMarkup(
      await TextPage({
        params: Promise.resolve({ locale: 'en' }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('Hey Hale, what&#x27;s going on?');
    expect(html).toContain(
      'Hey, it&#x27;s Hale. I find what&#x27;s on for kids near you. What&#x27;s your postal code? I&#x27;ll show you what&#x27;s on this week.',
    );
    expect(html).not.toContain(LOCKED_PREVIEW_EN);
    vi.unstubAllEnvs();
  });
});

/** The number the suite stubs. Chrome and the page both read it from the env. */
const LIVE_NUMBER = '+16475551234';

/** The two tags the bug drops: a co-parent join link, and a per-family referral. */
const JOIN_CODE = 'join-abc123';
const REFERRAL_CODE = 'friend-0123456789ab';

const LOCALES = ['en', 'fr', 'zh'] as const satisfies readonly Locale[];

function smsHrefs(html: string): string[] {
  return [...html.matchAll(/href="(sms:[^"]*)"/g)].map((match) =>
    (match[1] ?? '').replaceAll('&amp;', '&'),
  );
}

/** The path `QrCode` draws for a payload — the same `uqr` options, so a mismatch
 * means the SVG encodes a different sms: URI. */
function qrPathFor(value: string): string {
  const { data } = encode(value, { ecc: 'M', border: 2 });
  let path = '';
  for (const [y, row] of data.entries()) {
    for (const [x, dark] of row.entries()) {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }
  }
  return path;
}

function qrPath(html: string): string {
  const found = /aria-label="QR code — scan to text Hale"[\s\S]*?<path d="([^"]*)"/.exec(html);
  if (!found?.[1]) throw new Error('no QR path rendered');
  return found[1];
}

/** The decoded composer body, iOS (`&body=`) and cross (`?&body=`) both. */
function bodyOf(href: string): string {
  const raw = href.includes('?')
    ? href.slice(href.indexOf('?') + 1).replace(/^&/, '')
    : href.slice(href.indexOf('&') + 1);
  const value = new URLSearchParams(raw).get('body');
  if (value === null) throw new Error(`missing body in ${href}`);
  return value;
}

/** What the header pill would put in the body for this code — `buildSmsBody`. */
function headerPillBody(locale: Locale, source: string | null): string {
  const prefill = intakePrefill(locale);
  return bodyOf(
    primaryTextTarget({
      platform: 'apple',
      smsNumber: LIVE_NUMBER,
      prefill,
      source,
      textPath: localeHref(locale, '/text'),
    }).href,
  );
}

async function renderText(locale: Locale, s?: string | string[]): Promise<string> {
  return renderToStaticMarkup(
    await TextPage({
      params: Promise.resolve({ locale }),
      searchParams: Promise.resolve(s === undefined ? {} : { s }),
    }),
  );
}

describe('/text composer carries the ?s= code', () => {
  it('puts the join code and a referral code on every sms: href and the QR, in en, fr, and zh', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', LIVE_NUMBER);
    for (const locale of LOCALES) {
      for (const code of [JOIN_CODE, REFERRAL_CODE]) {
        const html = await renderText(locale, code);
        const prefill = intakePrefill(locale);
        const expected = buildSmsHref(LIVE_NUMBER, code, prefill, 'cross');
        const where = `${locale} ?s=${code}`;
        const hrefs = smsHrefs(html);
        // Hero and closing. A third sms: link on this page has to carry it too.
        expect(hrefs, where).toEqual([expected, expected]);
        const pill = headerPillBody(locale, code);
        expect(pill, where).toBe(buildSmsBody(code, prefill));
        for (const href of hrefs) {
          expect(bodyOf(href), where).toBe(pill);
          expect(href, where).toContain(`(via%20${code})`);
        }
        expect(qrPath(html), where).toBe(qrPathFor(expected));
        // The preview bubble stays the bare hello. The token rides in the link.
        expect(html, where).not.toContain(`(via ${code})`);
      }
    }
    vi.unstubAllEnvs();
  });

  it('leaves the composer exactly as the chrome CTA when no ?s= is present, in en, fr, and zh', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', LIVE_NUMBER);
    for (const locale of LOCALES) {
      const html = await renderText(locale);
      const prefill = intakePrefill(locale);
      const expected = buildSmsHref(LIVE_NUMBER, null, prefill, 'cross');
      // The no-code door is the shared chrome CTA, byte for byte.
      expect(expected, locale).toBe(chromeCta(locale).href);
      expect(smsHrefs(html), locale).toEqual([expected, expected]);
      expect(bodyOf(expected), locale).toBe(headerPillBody(locale, null));
      expect(bodyOf(expected), locale).toBe(prefill);
      expect(qrPath(html), locale).toBe(qrPathFor(expected));
      expect(html, locale).not.toContain('via%20');
      expect(html, locale).not.toContain('(via ');
    }
    vi.unstubAllEnvs();
  });

  it('drops a ?s= that is not a source code, same as leaving the param off', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', LIVE_NUMBER);
    const bare = await renderText('en');
    const rejected: Array<string | string[]> = ['JOIN-ABC', 'join-', ['join-abc123', REFERRAL_CODE]];
    for (const bad of rejected) {
      const html = await renderText('en', bad);
      expect(smsHrefs(html), String(bad)).toEqual(smsHrefs(bare));
      expect(qrPath(html), String(bad)).toBe(qrPath(bare));
    }
    vi.unstubAllEnvs();
  });
});

function chrome(html: string, tag: 'header' | 'footer'): string {
  const found = new RegExp(`<${tag}[\\s\\S]*</${tag}>`).exec(html)?.[0];
  if (!found) throw new Error(`no <${tag}> rendered`);
  return found;
}
