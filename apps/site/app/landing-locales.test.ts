import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { routing } from '~/i18n/routing.js';
import LandingPage from './[locale]/page.js';

/**
 * The loop is the landing's product shot, and it is the one section whose copy
 * is a per-locale ARRAY OF ARRAYS — five beats, each with its own rows. A
 * translator who drops a row silently shortens the story rather than throwing,
 * and `t.raw` returns whatever the bundle holds, so nothing else in the suite
 * would notice. (`LoopThread` throws on an EMPTY beat, which is the other half
 * of the same guard; a beat that merely loses one of three rows still renders.)
 *
 * This renders all three locales and asserts the loop's SHAPE, which is the part
 * that must not drift: five beats, the same eleven rows in the same order, and
 * two contrast cells.
 */

vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');

const HTML = Object.fromEntries(
  await Promise.all(
    routing.locales.map(async (locale) => [
      locale,
      renderToStaticMarkup(await LandingPage({ params: Promise.resolve({ locale }) })),
    ]),
  ),
) as Record<(typeof routing.locales)[number], string>;

/** The one conversation on the page. */
function loop(html: string): string {
  return html.match(/<div class="v5-loop"[\s\S]*?<\/ol>/)?.[0] ?? '';
}

function landingBundle(locale: string): Record<string, unknown> {
  return (
    JSON.parse(
      readFileSync(fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)), 'utf8'),
    ) as { Landing: Record<string, unknown> }
  ).Landing;
}

/** The hero H1 is `max-width: 15ch`, and a ch is the width of the display face's
 * zero: 0.606em in Fraunces (en/fr) and 0.46em in the serif the ≥1024px rule hands
 * zh, so the column is 9.09em wide for en/fr and 6.9em for zh (computed max-width
 * ÷ font-size, Chromium, 1440×900). A CJK glyph advances exactly 1em in every CJK
 * face, so a zh line is its glyph count plus the word space — one glyph too many
 * wraps the compound mid-word and pushes the hero CTA under the 900px fold, which
 * no static-markup test can see. Latin is counted at 0.42em, generous against the
 * 0.32em average measured for Fraunces at 450, so the estimate errs toward failing. */
const H1_COLUMN_EM: Record<(typeof routing.locales)[number], number> = {
  en: 9.09,
  fr: 9.09,
  zh: 6.9,
};

/* ── The ladder's two values, read out of apps/web ────────────────────────────
 * The loop's two municipal legs print a town, a clock and a link that all come
 * off ONE seeded registration window. `landing-v5.test.ts` derives the whole
 * sentence from that row for en; what this file adds is that fr and zh print the
 * SAME three facts, because a translator retyping a time is how the page ends up
 * promising a morning the town does not open on. (It shipped once: the loop said
 * "opens 7:00 a.m." against a row whose clock is noon.)
 *
 * The town is not translated and neither is the URL — `townLabel` is one
 * function with no locale argument, so a localized town name is a town the
 * product never says. */
function webSource(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../web/${path}`, import.meta.url)), 'utf8');
}

const LADDER = (() => {
  const data = webSource('lib/registration/registration-windows-data.ts');
  const row = /municipality: 'vaughan',\s*programDomain: 'swim',([\s\S]*?)\n\s*\},/.exec(data)?.[1];
  const urlConst = row === undefined ? undefined : /sourceUrl: (\w+),/.exec(row)?.[1];
  const url =
    urlConst === undefined
      ? undefined
      : new RegExp(`const ${urlConst} =\\s*'([^']+)';`).exec(data)?.[1];
  const opensAt = row === undefined ? undefined : /residentOpenAt: '([^']+)'/.exec(row)?.[1];
  if (url === undefined || opensAt === undefined) {
    throw new Error('apps/web moved the seeded vaughan/swim window — re-pin the loop with it');
  }
  return {
    town: 'Vaughan',
    link: url.replace(/^https:\/\/www\./, ''),
    hour: Number(
      new Intl.DateTimeFormat('en-CA', {
        hour: 'numeric',
        hour12: false,
        timeZone: 'America/Toronto',
      }).format(new Date(opensAt)),
    ),
  };
})();

function landingString(locale: string, key: string): string {
  const value = landingBundle(locale)[key];
  if (typeof value !== 'string') throw new Error(`${locale}.Landing.${key} is not a string`);
  return value;
}

function advanceEm(line: string): number {
  let em = 0;
  for (const ch of line) {
    if (/[　-〿一-鿿＀-￯]/u.test(ch)) em += 1;
    else if (ch === ' ') em += 0.25;
    else em += 0.42;
  }
  return em;
}

describe('the loop renders in every locale', () => {
  it.each(routing.locales)('%s runs five beats and eleven rows, in order', (locale) => {
    const html = loop(HTML[locale]);
    expect(html, 'the loop must render').toContain('v4-bubble');
    expect([...html.matchAll(/class="v5-beat"/g)]).toHaveLength(5);
    expect([...html.matchAll(/class="v5-stamp"/g)]).toHaveLength(5);
    // The parent's three turns are the yes that starts the watching, the outcome
    // she reports, and the line about her day. Each must land AFTER the message
    // that asks for it, in every language.
    const rows = [...html.matchAll(/class="v5-(stamp)"|class="v4-bubble v4-bubble-(in|out)"/g)].map(
      (m) => m[1] ?? m[2],
    );
    expect(rows).toEqual([
      'stamp',
      'out',
      'in',
      'out',
      'stamp',
      'in',
      'stamp',
      'in',
      'stamp',
      'in',
      'out',
      'in',
      'stamp',
      'in',
      'out',
      'in',
    ]);
  });

  it.each(routing.locales)('%s carries the municipal link Hale really sends', (locale) => {
    // Not translated: it is a URL. A locale that "translates" it points a parent
    // at a page that does not exist. Twice — the night before and the morning of,
    // which are the two legs whose URL is a dataset-verified string rather than
    // something a model composed.
    expect([
      ...loop(HTML[locale]).matchAll(new RegExp(LADDER.link.replaceAll('.', '\\.'), 'g')),
    ]).toHaveLength(2);
  });

  it.each(routing.locales)('%s answers about the town the parent named', (locale) => {
    // Every other assertion over the loop is structural, so a translator could
    // leave one language answering about a town the en copy has moved off, and
    // the suite would stay green.
    expect(loop(HTML[locale]), locale).toContain(LADDER.town);
  });

  it.each(routing.locales)('%s opens the ladder at the dataset row’s own hour', (locale) => {
    // "7 h 00" in fr and "上午 7:00" in zh are the same clock written three ways,
    // so the pin is the HOUR and a zero minute, in whatever separator the locale
    // sets. A translator who rounds it to 8 fails here.
    expect(loop(HTML[locale]), locale).toMatch(
      new RegExp(String.raw`\b${LADDER.hour}\s*[:h]\s*00\b`),
    );
  });

  it.each(routing.locales)(
    '%s keeps the three reply tokens in the bytes the parser reads',
    (locale) => {
      // ANSWER_MENU exists "so a parent who copies one back is guaranteed a match",
      // and the match is against English word lists (`sequence/reply.ts`
      // REGISTERED_WORDS / MISSED_WORDS). A translated « inscrit » is a reply Hale
      // cannot read, printed as an instruction — so the tokens stay English in
      // every locale, and so does the turn where the parent copies one back.
      //
      // COUNTED, not merely present: "got in" is printed twice — once in the menu
      // and once as the parent's copied reply — and a containment check alone
      // stays green when a locale translates the MENU and leaves the reply, which
      // is the half that breaks the parser's promise.
      const block = loop(HTML[locale]);
      for (const [token, times] of [
        ['got in', 2],
        ['waitlisted #12', 1],
        ['missed it', 1],
      ] as const) {
        expect(block.split(token).length - 1, `${locale} · ${token}`).toBe(times);
      }
    },
  );

  it.each(routing.locales)('%s renders three finds and both contrast cells', (locale) => {
    expect([...HTML[locale].matchAll(/class="v5-find"/g)]).toHaveLength(3);
    expect([...HTML[locale].matchAll(/class="v4-contrast[^"]*"/g)]).toHaveLength(1);
    // The one find whose source had not published a time keeps saying so, in
    // every language — dropping it is how a translation quietly invents a
    // schedule.
    expect([...HTML[locale].matchAll(/class="v5-find-gap"/g)]).toHaveLength(1);
  });

  it.each(routing.locales)('%s labels exactly two sections', (locale) => {
    expect([...HTML[locale].matchAll(/class="v4-eyebrow"/g)]).toHaveLength(2);
  });

  it.each(routing.locales)('%s has no homepage question chips', (locale) => {
    expect(HTML[locale]).not.toContain('class="v4-chip');
    expect(HTML[locale]).not.toContain('class="v4-chips"');
  });

  it('carries every Landing key in all three bundles — no locale silently renders a key name', () => {
    const keys = (locale: string) => Object.keys(landingBundle(locale)).sort();
    const en = keys('en');
    expect(en.length).toBeGreaterThan(30);
    for (const locale of routing.locales) expect(keys(locale), locale).toEqual(en);
  });

  it('carries every beat and every row in all three bundles', () => {
    // The key-set check above cannot see inside an array: a fr bundle with four
    // beats has the same keys as an en bundle with five.
    const beats = (locale: string) =>
      landingBundle(locale).heroLoop as { elapsed: string; rows: unknown[] }[];
    const shape = (locale: string) => beats(locale).map((beat) => beat.rows.length);
    expect(shape('en')).toEqual([3, 1, 1, 3, 3]);
    for (const locale of routing.locales) expect(shape(locale), locale).toEqual(shape('en'));
  });

  it.each(routing.locales)(
    '%s fits each hero H1 line inside the 15ch column at the desktop ceiling',
    (locale) => {
      // The markup forces one break: heroH1a, then heroH1b + a word space + the accent.
      const lines = [
        landingString(locale, 'heroH1a'),
        `${landingString(locale, 'heroH1b')} ${landingString(locale, 'heroH1Accent')}`,
      ];
      for (const line of lines) {
        expect(advanceEm(line), `${locale}: "${line}"`).toBeLessThanOrEqual(H1_COLUMN_EM[locale]);
      }
    },
  );

  it('would have caught the zh accent that wrapped mid-compound', () => {
    // The line that shipped as "之后便 安静下 / 来。" at 1440×900 and put the hero CTA under the fold.
    expect(advanceEm('之后便 安静下来。')).toBeGreaterThan(H1_COLUMN_EM.zh);
  });

  it.each(routing.locales)('%s keeps the loop evergreen — no calendar date', (locale) => {
    // A translator writing a beat has the same temptation to print the cycle the
    // row is drawn from. 20xx would be a cycle label; the clock times (9:15,
    // 7:00) are three digits or fewer either side of the colon and cannot match.
    const block = loop(HTML[locale]);
    expect(block, `${locale} · the loop must render`).toContain('v4-bubble');
    expect(block, locale).not.toMatch(/\b20\d\d\b/);
  });

  it.each(routing.locales)('%s says who is speaking, not only which side', (locale) => {
    // Direction is drawn with align-self and a fill, so a reader who cannot see
    // the alignment gets a bare "YES" with no idea whose turn it was. Every
    // bubble carries an sr-only speaker, and the loop opens on a caption saying
    // what the whole thread is — said only to the reader the layout does not
    // reach, because the hero has no fold height to spend on a line its sighted
    // reader can already see.
    const html = HTML[locale];
    const bubbles = [...html.matchAll(/<p class="v4-bubble[^"]*">(.*?)<\/p>/g)].map((m) => m[1]);
    expect(bubbles.length, 'the bubbles must render').toBe(11);
    for (const bubble of bubbles) expect(bubble).toMatch(/^<span class="sr-only">[^<]+ <\/span>/);
    expect(loop(html)).toMatch(/^<div class="v5-loop"><p class="sr-only">[^<]+</);
  });
});
