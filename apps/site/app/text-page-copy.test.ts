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

  const en = /export const HALE_GREETING_EN =\s*'([^']+)';/.exec(src)?.[1];
  const frAsk = /export const COLD_START_ASK_BY_LANGUAGE[\s\S]{0,400}?fr: "([^"]+)",/.exec(
    src,
  )?.[1];
  const frHead = /`(Bonjour, je suis Hale\.[^`]*?)\$\{COLD_START_ASK_BY_LANGUAGE\.fr\}`;/.exec(
    src,
  )?.[1];

  // Positive controls: extraction that silently matched nothing would turn
  // every byte-pin below into a vacuous undefined === undefined.
  if (!en || !frAsk || !frHead) {
    throw new Error('copy.ts greeting extraction failed — update the pins with the source');
  }
  expect(en.length).toBeGreaterThan(40);
  expect(en).toContain('sign-up mornings');

  return { en, fr: `${frHead}${frAsk}` };
}

describe('the preview bubble is Hale’s CURRENT greeting, byte-for-byte', () => {
  const source = greetingFromSource();

  it('EN: en.json Text.greeting matches copy.ts to the byte', () => {
    expect(source.en).toBe(
      'Hi — I’m Hale. I help plan your kids’ year — what’s on near them, sign-up mornings, and how it went. Names, ages, and postal code and I’ll look up what’s coming.',
    );
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
  });
});

/**
 * The ladder's first message, read out of copy.ts the same way the greeting
 * pin is: a byte comparison against the source, not a transpiled import.
 */
function ladderFromSource(): {
  imessage: { en: string; fr: string };
  sms: { en: string; fr: string };
} {
  const src = readFileSync(COPY_TS, 'utf8');
  const block = (name: string): string => {
    const start = src.indexOf(`export const ${name}`);
    const end = src.indexOf('};', start);
    if (start < 0 || end < 0) throw new Error(`${name} is missing from copy.ts`);
    return src.slice(start, end);
  };
  const literal = (chunk: string, lang: 'en' | 'fr'): string => {
    const at = chunk.indexOf(`${lang}:`);
    if (at < 0) throw new Error(`no ${lang} field`);
    let i = at + lang.length + 1;
    while (chunk[i] === ' ' || chunk[i] === '\n') i += 1;
    const quote = chunk[i];
    if (quote !== '"' && quote !== "'") throw new Error(`no string for ${lang}`);
    i += 1;
    let out = '';
    while (i < chunk.length) {
      const ch = chunk[i];
      if (ch === '\\') {
        out += chunk[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) return out;
      out += ch ?? '';
      i += 1;
    }
    throw new Error(`unterminated ${lang} string`);
  };
  const imessage = block('FIRST_TOUCH_IMESSAGE_BY_LANGUAGE');
  const sms = block('FIRST_TOUCH_SMS_BY_LANGUAGE');
  return {
    imessage: { en: literal(imessage, 'en'), fr: literal(imessage, 'fr') },
    sms: { en: literal(sms, 'en'), fr: literal(sms, 'fr') },
  };
}

describe('the preview bubble matches the ladder’s first message when the flag is on', () => {
  const ladder = ladderFromSource();

  it('pins the iMessage and SMS sentences to copy.ts, in EN and FR', () => {
    expect(ladder.imessage.en).toBe(
      "Hey, it's Hale. I find what's on for kids. Tap to share where you are and I'll show you what's on this week.",
    );
    expect(ladder.sms.en).toBe(
      "Hey, it's Hale. I find what's on for kids. What's your postal code? I'll show you what's on this week.",
    );
    expect(ladder.imessage.fr).toBe(
      "Salut, c'est Hale. Je trouve ce qui se passe pour les enfants. Partage ta position et je te montre ce qui est au programme cette semaine.",
    );
    expect(ladder.sms.fr).toBe(
      "Salut, c'est Hale. Je trouve ce qui se passe pour les enfants. Quel est ton code postal? Je te montre ce qui est au programme cette semaine.",
    );
    expect(messages('en').Text.greetingLadderImessage).toBe(ladder.imessage.en);
    expect(messages('en').Text.greetingLadderSms).toBe(ladder.sms.en);
    expect(messages('fr').Text.greetingLadderImessage).toBe(ladder.imessage.fr);
    expect(messages('fr').Text.greetingLadderSms).toBe(ladder.sms.fr);
    expect(messages('zh').Text.greetingLadderImessage).toBe(ladder.imessage.en);
    expect(messages('zh').Text.greetingLadderSms).toBe(ladder.sms.en);
  });

  it('shows the iMessage sentence on Apple phone and Mac, and the postal sentence everywhere else', () => {
    for (const locale of ['en', 'fr', 'zh'] as const) {
      const imessage = locale === 'fr' ? ladder.imessage.fr : ladder.imessage.en;
      const sms = locale === 'fr' ? ladder.sms.fr : ladder.sms.en;
      expect(render(locale, { firstTouchLadder: true, platform: 'apple' })).toContain(
        escapeHtml(imessage),
      );
      expect(render(locale, { firstTouchLadder: true, platform: 'desktop-mac' })).toContain(
        escapeHtml(imessage),
      );
      expect(render(locale, { firstTouchLadder: true, platform: 'android' })).toContain(
        escapeHtml(sms),
      );
      expect(render(locale, { firstTouchLadder: true, platform: 'unknown' })).toContain(
        escapeHtml(sms),
      );
      expect(render(locale, { firstTouchLadder: true, platform: 'apple' })).not.toContain(
        escapeHtml(sms),
      );
    }
  });

  it('leaves the parent prefill and the flag-off greeting untouched', () => {
    const html = render('en', { firstTouchLadder: true, platform: 'apple' });
    expect(html).toContain(escapeHtml("Hey Hale, what's going on?"));
    expect(render('en')).toContain(escapeHtml(greetingFromSource().en));
    expect(render('en')).not.toContain(escapeHtml(ladder.sms.en));
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
  const patterns = [new RegExp(`${first}(?:\\s|%20)+is`), new RegExp(`${second}(?:\\s|%20)+is`)];

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
