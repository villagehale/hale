import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TextEntry } from '~/components/text-entry.js';
import type { Locale } from '~/i18n/routing.js';

/**
 * /text says what Hale IS, what to DO, and what comes BACK — and the "what
 * comes back" bubble is Hale's REAL first reply (founder brief 2026-09-01,
 * post-#592/#593). Two structural pins live here:
 *
 *   1. The greeting bubble is byte-pinned to the intake copy SOURCE
 *      (apps/web/lib/channel/intake/copy.ts). One character of drift between
 *      what the page promises and what the machine sends is a red test, not a
 *      support thread.
 *   2. The dummy family is gone. 'M...a is 4, T...o is 18 months' was a
 *      prefill two strangers would have had to edit before sending; nothing in
 *      apps/site may reintroduce it, encoded or plain.
 */

const SITE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const COPY_TS = fileURLToPath(new URL('../../web/lib/channel/intake/copy.ts', import.meta.url));

const LIVE_NUMBER = '+16475551234';

function render(locale: Locale, props: Partial<Parameters<typeof TextEntry>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(TextEntry, {
      source: null,
      smsNumber: LIVE_NUMBER,
      platform: 'apple',
      locale,
      ...props,
    }),
  );
}

/** Text children the way react-dom/server escapes them, so a verbatim string
 * can be asserted against static markup. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

function messages(locale: Locale): { Text: Record<string, string> } {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)), 'utf8'),
  );
}

/**
 * The greeting reconstructed from copy.ts SOURCE — the same concatenation
 * `greeting(null, language)` performs, read out of the file rather than
 * imported so this stays a byte comparison against what is written there,
 * not against whatever a transpiled import happens to evaluate to.
 */
function greetingFromSource(): { en: string; fr: string } {
  const src = readFileSync(COPY_TS, 'utf8');

  const enAsk = /export const COLD_START_ASK =\s*"([^"]+)";/.exec(src)?.[1];
  const frAsk = /export const COLD_START_ASK_BY_LANGUAGE[\s\S]{0,400}?fr: "([^"]+)",/.exec(
    src,
  )?.[1];
  const enHead = /return `(Hi, I'm Hale\.[^`]*?)\$\{COLD_START_ASK\}`;/.exec(src)?.[1];
  const frHead = /`(Bonjour, je suis Hale\.[^`]*?)\$\{COLD_START_ASK_BY_LANGUAGE\.fr\}`;/.exec(
    src,
  )?.[1];

  // Positive controls: extraction that silently matched nothing would turn
  // every byte-pin below into a vacuous undefined === undefined.
  if (!enAsk || !frAsk || !enHead || !frHead) {
    throw new Error('copy.ts greeting extraction failed — update the pins with the source');
  }
  expect(enAsk.length).toBeGreaterThan(40);
  expect(enHead).toContain('sign-up mornings');

  return { en: `${enHead}${enAsk}`, fr: `${frHead}${frAsk}` };
}

describe('the preview bubble is Hale’s CURRENT greeting, byte-for-byte', () => {
  const source = greetingFromSource();

  it('EN: en.json Text.greeting matches copy.ts to the byte', () => {
    expect(messages('en').Text.greeting).toBe(source.en);
  });

  it('FR: fr.json Text.greeting is the French twin from copy.ts, GSM-7 fold included', () => {
    expect(messages('fr').Text.greeting).toBe(source.fr);
    // The one deliberate misspelling in the French script survives verbatim.
    expect(messages('fr').Text.greeting).toContain("l'age");
  });

  it('ZH: copy.ts has no Chinese greeting, so the bubble stays the English bytes — never invented speech', () => {
    expect(messages('zh').Text.greeting).toBe(source.en);
  });

  it('renders those exact bytes into the page bubble, per locale', () => {
    expect(render('en')).toContain(escapeHtml(source.en));
    expect(render('fr')).toContain(escapeHtml(source.fr));
    expect(render('zh')).toContain(escapeHtml(source.en));
    // And on the chooser arm too — the promise does not change with the pipe.
    expect(render('en', { whatsappNumber: LIVE_NUMBER })).toContain(escapeHtml(source.en));
  });
});

describe('the (via …) token never renders as page copy', () => {
  const SOURCE = 'earlyon-richmondhill';

  it('appears ONLY inside href attributes, across locales and platforms', () => {
    for (const locale of ['en', 'fr', 'zh'] as const) {
      for (const platform of ['apple', 'desktop-other'] as const) {
        const html = render(locale, { source: SOURCE, platform });
        const textNodes = html.replace(/<[^>]+>/g, ' ');
        expect(textNodes, `${locale}/${platform} must not print the raw token`).not.toContain(
          '(via',
        );
        expect(textNodes, `${locale}/${platform} must not print the code`).not.toContain(SOURCE);
      }
      // Positive control per locale: on the arm that renders a composer anchor
      // the attribution rides in its href — the absences above mean "moved into
      // the link", never "attribution lost". (desktop-other has no sms: anchor
      // at all; its QR encodes the same URI as module geometry.)
      const apple = render(locale, { source: SOURCE, platform: 'apple' });
      const anchor = /<a\s[^>]*href="sms:[^"]*"[^>]*>/.exec(apple)?.[0] ?? '';
      expect(anchor, `${locale} must keep the token in the composer href`).toContain(
        `(via%20${SOURCE})`,
      );
    }
  });
});

describe('the dummy family is gone from apps/site', () => {
  // Assembled so this file cannot match its own patterns.
  const first = ['Ma', 'ya'].join('');
  const second = ['Th', 'eo'].join('');
  const patterns = [
    new RegExp(`${first}(?:\\s|%20)+is`),
    new RegExp(`${second}(?:\\s|%20)+is`),
  ];

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.next', 'dist', 'coverage', '.turbo'].includes(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) out.push(...walk(path));
      else if (/\.(ts|tsx|js|mjs|json|txt|md|css)$/.test(name)) out.push(path);
    }
    return out;
  }

  it('no source file carries the sample family, plain or percent-encoded', () => {
    const files = walk(SITE_ROOT);
    expect(files.length).toBeGreaterThan(100); // positive control: the walk saw the tree
    const offenders = files.filter((file) => {
      const raw = readFileSync(file, 'utf8');
      return patterns.some((pattern) => pattern.test(raw));
    });
    expect(offenders).toEqual([]);
  });

  it('positive control: the patterns do catch the old prefill in both shapes', () => {
    expect(patterns[0]?.test(`${first} is 4`)).toBe(true);
    expect(patterns[0]?.test(`${first}%20is%204`)).toBe(true);
    expect(patterns[1]?.test(`${second} is 18 months`)).toBe(true);
  });
});
