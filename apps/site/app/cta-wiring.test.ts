import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * THE FUNNEL HAS NO HOLES — every `sms:` link the site offers is counted.
 *
 * Tapping through to the SMS composer is this site's only conversion, and it is ONE
 * event with a `cta_placement` breakdown (`cta_text_click`, lib/analytics/events.ts).
 * That only holds if every composer link fires it. Seven did not: they were written as
 * plain `<a href={cta.href}>` beside wired ones, and an `onClick` leaves no trace in
 * rendered markup, so nothing could tell them apart — the pricing band, all three
 * pricing tier cards, /about, and both /answers surfaces sent readers to a composer
 * no dashboard ever saw.
 *
 * So the pin is STRUCTURAL rather than a list of those seven, and it is in two halves
 * because neither alone is complete:
 *
 *  - The WALK renders every page off the page tree and checks every `sms:` anchor in
 *    the output, however that href was built. It covers a new page the day it is added.
 *  - The SOURCE SCAN catches what no render can reach: a CTA inside a branch that does
 *    not render today. That is exactly where the seventh miss lived — /answers has an
 *    empty-state panel that only appears with no published guides.
 *
 * English only for the walk: the wiring is markup shape, which no locale changes. The
 * number must be stubbed, because with none provisioned the whole site degrades to
 * `mailto:` and there would be nothing to assert over (see the controls below).
 */

const LIVE_NUMBER = '+16475551234';
const SITE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCALE_ROOT = join(SITE_ROOT, 'app', '[locale]');

/** A rendering fixture per dynamic segment the app declares. */
const DYNAMIC_PARAMS: Record<string, string> = {
  slug: 'introducing-peanuts-to-baby',
  city: 'toronto',
  age: '6-months',
};

function routeOf(pageFile: string): string {
  const dir = dirname(pageFile).split(/[\\/]/).join('/');
  return dir === '.' ? '/' : `/${dir}`;
}

function paramsFor(route: string): Record<string, string> {
  const params: Record<string, string> = { locale: 'en' };
  for (const match of route.matchAll(/\[(\w+)\]/g)) {
    const segment = match[1] as string;
    const fixture = DYNAMIC_PARAMS[segment];
    if (fixture === undefined) {
      throw new Error(`no render fixture for the dynamic segment [${segment}] on ${route}`);
    }
    params[segment] = fixture;
  }
  return params;
}

/** True for the throw `redirect()`/`permanentRedirect()` uses to unwind a render. */
function isRedirect(error: unknown): boolean {
  return String((error as { digest?: unknown })?.digest ?? '').startsWith('NEXT_REDIRECT');
}

const pageFiles = readdirSync(LOCALE_ROOT, { recursive: true, encoding: 'utf8' })
  .filter((entry) => /(^|[\\/])page\.tsx$/.test(entry))
  .sort();

vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', LIVE_NUMBER);
const rendered: { route: string; html: string }[] = [];
const redirected: string[] = [];
for (const pageFile of pageFiles) {
  const route = routeOf(pageFile);
  const { default: Page } = await import(pathToFileURL(join(LOCALE_ROOT, pageFile)).href);
  try {
    rendered.push({
      route,
      html: renderToStaticMarkup(
        await Page({
          params: Promise.resolve(paramsFor(route)),
          searchParams: Promise.resolve({}),
        }),
      ),
    });
  } catch (error) {
    // A retired route redirects instead of rendering — it has no anchors to check.
    if (!isRedirect(error)) throw error;
    redirected.push(route);
  }
}
vi.unstubAllEnvs();

const smsAnchors = rendered.flatMap(({ route, html }) =>
  [...html.matchAll(/<a\s[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => tag.includes('href="sms:'))
    .map((tag) => ({ route, tag })),
);

const placements = new Set(
  smsAnchors.map((anchor) => /data-cta-placement="([^"]*)"/.exec(anchor.tag)?.[1] ?? ''),
);

/** The desktop chips, collected off the same walk: `sms:` is a silent no-op on a
 * laptop, so wherever a band offers a composer it offers the clipboard too, and
 * the chip wears the same visible `data-cta` wiring as the anchors above. */
const copyChips = rendered.flatMap(({ route, html }) =>
  [...html.matchAll(/<button\s[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => tag.includes('data-cta="copy_number_click"'))
    .map((tag) => ({ route, tag })),
);

const chipPlacements = new Set(
  copyChips.map((chip) => /data-cta-placement="([^"]*)"/.exec(chip.tag)?.[1] ?? ''),
);

/** Every component and page file the site ships, read as source. */
const sourceFiles = ['app', 'components']
  .flatMap((dir) =>
    readdirSync(join(SITE_ROOT, dir), { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.tsx'))
      .map((entry) => join(dir, entry)),
  )
  .sort();

/** Source with comments removed — a doc comment describing the bug is not the bug. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Bare `<a>` tags in source whose href is an expression matching `hrefPattern`. */
function rawAnchors(hrefPattern: string): string[] {
  const anchor = new RegExp(`<a\\s[^>]*href=\\{[^>]*(?:${hrefPattern})[^>]*>`, 'g');
  return sourceFiles.flatMap((file) => {
    const source = code(readFileSync(join(SITE_ROOT, file), 'utf8'));
    return [...source.matchAll(anchor)].map(
      (match) => `${file} — ${match[0].replace(/\s+/g, ' ')}`,
    );
  });
}

describe('every sms: CTA on the site is wired to the funnel', () => {
  it('walks the whole page tree, rendering or accounting for each route', () => {
    // A page the loop never reaches is a page whose CTAs are never checked, and both
    // halves are asserted so neither a page that quietly stopped rendering nor a new
    // page nobody rendered can pass as "all clear".
    expect(pageFiles.length).toBeGreaterThanOrEqual(14);
    expect(rendered.length + redirected.length).toBe(pageFiles.length);
    expect([...redirected].sort()).toEqual(['/milestones', '/milestones/[age]']);
  });

  it('fires cta_text_click from every composer link, on every page', () => {
    const unwired = smsAnchors.filter(
      (anchor) => !anchor.tag.includes('data-cta="cta_text_click"'),
    );
    expect(
      unwired.map((anchor) => `${anchor.route} — ${anchor.tag}`),
      'these sms: anchors open a composer no event counts — render them through LandingCta',
    ).toEqual([]);
  });

  it('names a placement on each, so the one event stays readable as a breakdown', () => {
    // An sms: CTA with no `cta_placement` merges into an unnamed bucket, which is the
    // same failure as not firing at all: the funnel is one number precisely because the
    // breakdown says which door produced it.
    const unnamed = smsAnchors.filter((anchor) => !/data-cta-placement="[^"]+"/.test(anchor.tag));
    expect(unnamed.map((anchor) => `${anchor.route} — ${anchor.tag}`)).toEqual([]);
    expect(placements.size).toBeGreaterThanOrEqual(10);
  });

  it('leaves no bare composer anchor in a branch the render never reaches', () => {
    // The walk sees /answers with guides published, so its empty-state CTA — one of the
    // original seven — renders on no page a test can load. Source is the only place a
    // dormant branch exists, so the composer hrefs are pinned there too: `cta.href` is
    // the shared chrome CTA, `smsHref`/`buildSmsHref…` the pages that build their own.
    expect(rawAnchors('cta\\.href|smsHref|buildSmsHref')).toEqual([]);
  });

  /**
   * The positive controls. Every assertion above is satisfied by an EMPTY list, so
   * without these they would pass just as happily if the walk rendered nothing, the
   * number never got stubbed, or either regex stopped matching JSX.
   */
  it('really is reading rendered anchors — the known-wired CTAs are all present', () => {
    expect(smsAnchors.length).toBeGreaterThanOrEqual(20);
    for (const placement of ['header', 'hero', 'closing', 'faq', 'text_entry']) {
      expect(placements, `the walk must reach the ${placement} CTA`).toContain(placement);
    }
    // The city pages' in-body door (2026-08 ad week): the dates table is what
    // the ad promised, so each guide offers the composer right under it, on its
    // own `_dates` placement, separable from the closing band's.
    expect(placements).toContain('toronto_swim_dates');
    expect(smsAnchors.every((anchor) => anchor.tag.includes(`href="sms:${LIVE_NUMBER}`))).toBe(
      true,
    );
  });

  it('really is reading source anchors — the email fallbacks it must NOT flag are found', () => {
    // The same scanner, pointed at the bare `<a>` tags that are correct: where no number
    // is provisioned the CTA degrades to `mailto:`, which is not a conversion and is not
    // wired. Finding those proves an empty result above means "none left", not "regex
    // matches nothing".
    expect(rawAnchors('CONTACT_EMAIL').length).toBeGreaterThanOrEqual(3);
    expect(sourceFiles.length).toBeGreaterThanOrEqual(20);
  });
});

describe('the desktop path is wired the same way', () => {
  it('names a placement on every copy-number chip', () => {
    // A chip with no `cta_placement` merges into the unnamed bucket — the same
    // failure as an unwired anchor: the desktop funnel stops saying which door.
    const unnamed = copyChips.filter((chip) => !/data-cta-placement="[^"]+"/.test(chip.tag));
    expect(unnamed.map((chip) => `${chip.route} — ${chip.tag}`)).toEqual([]);
  });

  it('really is reading the chips — the known copy chips are all present', () => {
    // Positive control, same shape as the anchors': an empty "unnamed" list must
    // mean "all named", not "the walk found no buttons".
    expect(copyChips.length).toBeGreaterThanOrEqual(10);
    for (const placement of [
      'hero',
      'closing',
      'text_entry',
      'faq',
      'about',
      'pricing_band',
      'toronto_swim_dates',
    ]) {
      expect(chipPlacements, `the walk must reach the ${placement} chip`).toContain(placement);
    }
  });
});

describe('the money pages report engagement, not just clicks', () => {
  it('mounts the scroll tracker on the city guides, named per page', () => {
    // LandingScrollAnalytics renders NOTHING, so no walk over markup can see a
    // page that quietly stopped mounting it — source is the only surface the
    // wiring exists on. The city guides stamp a coarse `page` (the guide's
    // placement) on their `landing_scroll`; the homepage mounts it bare, since
    // its historical rows carry no `page` and absent must keep meaning "the
    // landing".
    const registration = code(
      readFileSync(join(SITE_ROOT, 'components/registration-page.tsx'), 'utf8'),
    );
    expect(registration).toContain('<LandingScrollAnalytics page={guide.placement} />');
    const landing = code(
      readFileSync(join(SITE_ROOT, 'components/landing/v4/landing-v4.tsx'), 'utf8'),
    );
    expect(landing).toContain('<LandingScrollAnalytics />');
  });
});
