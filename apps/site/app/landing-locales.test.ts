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

describe('the registration loop renders in every locale', () => {
  it.each(routing.locales)('%s runs four legs and seven bubbles, in order', (locale) => {
    const html = HTML[locale];
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

  it.each(routing.locales)('%s keeps the demo evergreen — no calendar date', (locale) => {
    const thread = HTML[locale].match(/<div class="v4-thread[\s\S]*?<\/section>/)?.[0] ?? '';
    expect(thread, 'the thread must render').toContain('v4-thread-time');
    // 20xx would be a cycle label; the clock times (10:04, 7:00) are three digits
    // or fewer either side of the colon and cannot match.
    expect(thread).not.toMatch(/\b20\d\d\b/);
  });
});
