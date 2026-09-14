import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { routing } from '~/i18n/routing.js';
import LandingPage from './[locale]/page.js';

/**
 * The registration loop is the landing's product shot, and it is the one section
 * whose copy is a per-locale ARRAY — a translator who drops a row silently
 * shortens the story rather than throwing. next-intl's `t.raw` returns whatever
 * the bundle holds, so nothing else in the suite would notice.
 *
 * This renders all three locales and asserts the loop's SHAPE, which is the part
 * that must not drift: four timestamps, the same seven bubbles in the same
 * order, three timed steps and two contrast cells.
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

/** The transcript section only — the hero carries its own three bubbles now, so
 * a page-wide scan would count two conversations as one. `v4-thread-cap` is the
 * caption only the transcript wears. */
function transcript(html: string): string {
  return html.match(/<p class="v4-thread-cap"[\s\S]*?<\/section>/)?.[0] ?? '';
}

describe('the registration loop renders in every locale', () => {
  it.each(routing.locales)('%s runs four legs and seven bubbles, in order', (locale) => {
    const html = transcript(HTML[locale]);
    expect(html, 'the transcript must render').toContain('v4-bubble');
    expect([...html.matchAll(/class="v4-thread-time"/g)]).toHaveLength(4);
    expect([...html.matchAll(/class="v4-bubble v4-bubble-in"/g)]).toHaveLength(5);
    expect([...html.matchAll(/class="v4-bubble v4-bubble-out"/g)]).toHaveLength(2);
    // The out-bubbles are the parent's two turns: the yes that unlocks the
    // quiet-hours-exempt legs, then the outcome. Both must land AFTER the leg
    // that asks for them, in every language.
    const rows = [...html.matchAll(/class="v4-(thread-time|bubble v4-bubble-(?:in|out))"/g)].map(
      (m) => (m[1] === 'thread-time' ? 'time' : m[0].endsWith('out"') ? 'out' : 'in'),
    );
    expect(rows).toEqual([
      'time',
      'in',
      'out',
      'time',
      'in',
      'time',
      'in',
      'time',
      'in',
      'out',
      'in',
    ]);
  });

  it.each(routing.locales)('%s carries the municipal link Hale really sends', (locale) => {
    // Not translated: it is a URL. A locale that "translates" it points a parent
    // at a page that does not exist.
    expect(HTML[locale]).toContain('haltonhills.ca/Play/Recreation/Programs');
  });

  it.each(routing.locales)('%s marks all three steps and both contrast cells', (locale) => {
    expect([...HTML[locale].matchAll(/class="v4-when"/g)]).toHaveLength(3);
    expect([...HTML[locale].matchAll(/class="v4-contrast[^"]*"/g)]).toHaveLength(1);
  });

  it.each(routing.locales)('%s has no homepage question chips', (locale) => {
    const html = HTML[locale];
    expect(html).not.toContain('class="v4-chip');
    expect(html).not.toContain('class="v4-chips"');
    expect(html).not.toContain('hero_chip');
  });

  it.each(routing.locales)(
    '%s opens on the hero exchange — three bubbles, before the transcript',
    (locale) => {
      // Boardy: a believable request and Hale's answer, above the fold, in every
      // language. It is the same bubble styling, in a hero-scoped wrapper, so the
      // transcript scans above stay about the transcript.
      const hero =
        HTML[locale].match(/<section class="v4-hero v4-hero-top"[\s\S]*?<\/section>/)?.[0] ?? '';
      expect(hero, 'the hero must render').toContain('v4-hero-thread');
      expect([...hero.matchAll(/class="v4-bubble v4-bubble-out"/g)]).toHaveLength(2);
      expect([...hero.matchAll(/class="v4-bubble v4-bubble-in"/g)]).toHaveLength(1);
      expect(hero).not.toContain('v4-thread-time');
      // The hero exchange must land before the transcript's own label.
      expect(HTML[locale].indexOf('v4-hero-thread')).toBeLessThan(
        HTML[locale].indexOf('v4-thread-cap'),
      );
    },
  );

  it('carries every Landing key in all three bundles — no locale silently renders a key name', () => {
    const keys = (locale: string) =>
      Object.keys(
        (
          JSON.parse(
            readFileSync(
              fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)),
              'utf8',
            ),
          ) as { Landing: Record<string, unknown> }
        ).Landing,
      ).sort();
    const en = keys('en');
    expect(en.length).toBeGreaterThan(30);
    for (const locale of routing.locales) expect(keys(locale), locale).toEqual(en);
  });

  it.each(routing.locales)('%s keeps the demo evergreen — no calendar date', (locale) => {
    const thread = transcript(HTML[locale]);
    expect(thread, 'the thread must render').toContain('v4-thread-time');
    // 20xx would be a cycle label; the clock times (10:04, 7:00) are three digits
    // or fewer either side of the colon and cannot match.
    expect(thread).not.toMatch(/\b20\d\d\b/);
  });
});
