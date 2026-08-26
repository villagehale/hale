import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLAN_DISPLAY, PLAN_TIERS_ORDERED } from '@hale/types';
import postcss from 'postcss';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AboutPage from './[locale]/about/page.js';
import ActivityCityRoute from './[locale]/activities/[city]/page.js';
import ActivitiesHub from './[locale]/activities/page.js';
import AnswerRoute from './[locale]/answers/[slug]/page.js';
import AnswersIndexPage from './[locale]/answers/page.js';
import BramptonSwimPage from './[locale]/brampton-swim-registration/page.js';
import ContactPage from './[locale]/contact/page.js';
import FaqPage from './[locale]/faq/page.js';
import PricingPage from './[locale]/pricing/page.js';
import PrivacyPage from './[locale]/privacy/page.js';
import TermsPage from './[locale]/terms/page.js';
import TorontoFallPage from './[locale]/toronto-fall-recreation-registration/page.js';
import TorontoSwimPage from './[locale]/toronto-swim-registration/page.js';
import YmcaSwimPage from './[locale]/ymca-gta-swim-registration/page.js';

/**
 * The subpage design language (2026-08) — the five devices that carried the
 * landing's cinema onto the ten pages behind it, and the properties that must
 * hold for every one of them.
 *
 * The through-line of these assertions is that the language degrades to readable
 * text. Each device is an animation over content that is already in the markup,
 * so a crawler, a reader with JavaScript off, and a reader who asked for less
 * motion all get the page — never an empty headline or a paragraph stuck at 20%
 * opacity. That is the failure mode a word-splitting reveal invites, and it is
 * what these pins exist to make impossible.
 */

const CSS = readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8');

/** Text with the tags removed and NOTHING put in their place — so a space that
 * only exists as markup (or has been lost between two inline-blocks) shows up as
 * two words run together rather than being invented by the helper. */
function rawText(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function heading(html: string, level: 1 | 2 = 1): string {
  const found = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`).exec(html)?.[1];
  if (found === undefined) throw new Error(`no <h${level}> in this page`);
  return found;
}

async function renderAsync(element: Promise<React.ReactElement>): Promise<string> {
  return renderToStaticMarkup(await element);
}

// Every page is now an async Server Component keyed by `[locale]`; these render
// the English (default-locale) markup the design pins assert against.
const EN = { locale: 'en' as const };

const pages = {
  '/about': await renderAsync(AboutPage({ params: Promise.resolve(EN) })),
  '/pricing': await renderAsync(PricingPage({ params: Promise.resolve(EN) })),
  '/faq': await renderAsync(FaqPage({ params: Promise.resolve(EN) })),
  '/contact': await renderAsync(ContactPage({ params: Promise.resolve(EN) })),
  '/answers': await renderAsync(AnswersIndexPage({ params: Promise.resolve(EN) })),
  '/activities': await renderAsync(ActivitiesHub({ params: Promise.resolve(EN) })),
} as const;

const slugHtml = await renderAsync(
  AnswerRoute({ params: Promise.resolve({ slug: 'introducing-peanuts-to-baby', ...EN }) }),
);
const cityHtml = await renderAsync(
  ActivityCityRoute({ params: Promise.resolve({ city: 'toronto', ...EN }) }),
);
const torontoFallHtml = await renderAsync(TorontoFallPage({ params: Promise.resolve(EN) }));
const torontoSwimHtml = await renderAsync(TorontoSwimPage({ params: Promise.resolve(EN) }));
const bramptonSwimHtml = await renderAsync(BramptonSwimPage({ params: Promise.resolve(EN) }));
const ymcaSwimHtml = await renderAsync(YmcaSwimPage({ params: Promise.resolve(EN) }));
const privacyHtml = await renderAsync(PrivacyPage({ params: Promise.resolve(EN) }));
const termsHtml = await renderAsync(TermsPage({ params: Promise.resolve(EN) }));

/** The eight pages that wear the pulled-up headline, and the sentence each must
 * still read as once the words are split apart. */
const PULLED_UP: [name: string, html: string, headline: string][] = [
  ['/about', pages['/about'], 'Why Hale is a number, not another app.'],
  ['/pricing', pages['/pricing'], 'Free while Hale is new.'],
  ['/faq', pages['/faq'], 'Is Hale right for your family?'],
  ['/contact', pages['/contact'], 'Say hello.'],
  ['/answers', pages['/answers'], 'Calm, cited guidance for every stage.'],
  ['/activities', pages['/activities'], 'Things to do with your kids, by city.'],
  ['/answers/[slug]', slugHtml, 'When and how do I introduce peanuts to my baby?'],
  ['/activities/[city]', cityHtml, 'Things to do with your kids in Toronto'],
  [
    '/toronto-fall-recreation-registration',
    torontoFallHtml,
    'Toronto fall recreation registration 2026: which 7 a.m. is yours',
  ],
  [
    '/toronto-swim-registration',
    torontoSwimHtml,
    'Toronto swim registration 2026: it is not a separate day',
  ],
  [
    '/brampton-swim-registration',
    bramptonSwimHtml,
    'Brampton swim registration is September 9, not August 24',
  ],
  [
    '/ymca-gta-swim-registration',
    ymcaSwimHtml,
    'YMCA Greater Toronto swim registration: August 27 at 9 a.m.',
  ],
];

describe('the pulled-up headline', () => {
  it.each(PULLED_UP)('reads as its whole sentence on %s', (_name, html, headline) => {
    const h1 = heading(html);
    expect(h1).toContain('pull-word');
    expect(rawText(h1)).toBe(headline);

    // …and the spaces are BETWEEN the word boxes, not inside them. A browser
    // trims trailing whitespace at the end of an inline-block, so a space moved
    // one level in renders as "WhyHaleisanumber" while every text-based
    // assertion above still passes. Position is the only thing that catches it.
    const words = [...h1.matchAll(/class="pull-word/g)].length;
    expect(words).toBe(headline.split(' ').length);
    expect([...h1.matchAll(/<\/span> <span class="pull-word/g)]).toHaveLength(words - 1);
  });

  it.each(PULLED_UP)('gives %s exactly one accent segment', (_name, html) => {
    const h1 = heading(html);
    // The accent word is the v4 device — amber at the heading's own weight,
    // upright — the same one the v4 landing hero wears (`v4-accent`).
    const accented = [...h1.matchAll(/class="pull-word v4-accent"/g)];
    expect(accented.length).toBeGreaterThan(0);
    // One RUN of accented words, not two — the device is a single segment per
    // headline, and two would read as a mistake rather than an emphasis.
    const runs = h1
      .split(/class="pull-word"/)
      .filter((part) => part.includes('pull-word v4-accent'));
    expect(runs).toHaveLength(1);
  });

  it.each(PULLED_UP)('sets %s in the v4 display serif', (_name, html) => {
    // The re-skin in one pin: every subpage headline wears the site's display
    // rule (.v4-display), the same one the v4 landing hero wears, rather than the
    // old sans display. The class rides on the heading tag WordsPullUp emits.
    expect(html).toMatch(/<h1[^>]*class="v4-display[^"]*"/);
  });

  it('staggers by word index, from zero, across the whole headline', () => {
    const h1 = heading(pages['/about']);
    const indices = [...h1.matchAll(/--w:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // The beat runs across the style change rather than restarting at the accent.
    expect(h1.indexOf('--w:3')).toBeLessThan(h1.indexOf('--w:4'));
  });

  it('holds every word still under prefers-reduced-motion', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g;
    const blocks = [...CSS.matchAll(reduced)].map((m) => m[1] ?? '');
    const guard = blocks.find((block) => block.includes('.pull-word'));
    expect(guard, '.pull-word must appear in a reduced-motion block').toBeDefined();
    expect(guard).toMatch(/\.pull-word \{ animation: none; opacity: 1; \}/);
    // Positive control: the same scan finds the landing's guard, so a match above
    // means "the rule is there" rather than "the regex matches anything".
    expect(blocks.some((block) => block.includes('.hale-hero-word'))).toBe(true);
  });

  it('leaves the homepage on its own v4 hero display, not the subpage reveal', () => {
    // Home is the v4 liquid-glass shore: its hero display is set large
    // (.v4-display / .v4-hero-h1), not the subpage pulled-up reveal. The two
    // never share the pull-word device — only the amber accent.
    const landing = readFileSync(
      fileURLToPath(new URL('../components/landing/v4/landing-v4.tsx', import.meta.url)),
      'utf8',
    );
    expect(landing).not.toContain('pull-word');
    expect(landing).not.toContain('WordsPullUp');
    expect(landing).toContain('v4-display');
    expect(landing).toContain('v4-accent');
  });
});

describe('the accent is one device, whole site', () => {
  it('paints it from a single rule, so the subpages and the landing cannot drift', () => {
    // It was two rules — the landing's glowed, eight subpages had a plain italic
    // — then one amber rule, and since 2026-08-20 not a colour at all: display
    // copy is one colour and amber belongs to what a reader can act on. The
    // single rule survives because the SEGMENT survives (WordsPullUp still marks
    // one run per headline, and the tests above still pin that markup) — it just
    // no longer diverges. See display-type.test.ts for the no-slant, no-amber and
    // no-italic-master gates.
    expect([...CSS.matchAll(/\.v4-accent \{/g)]).toHaveLength(1);
    expect(CSS).toContain('.v4-accent { color: inherit; }');
  });
});

describe('/about — the paragraph that reads itself', () => {
  const html = pages['/about'];

  it('serves the founder’s story as settled, readable text', () => {
    // Split into characters, and every one of them still in the markup: the
    // paragraph is a reveal over real content, never content the reveal creates.
    expect(rawText(html)).toContain(
      'Hale is built by Anzhe Dong — a father, husband, and founder who spent years shipping production agentic systems.',
    );
    expect(rawText(html)).toContain(
      'So he built the thing he kept wishing someone would text him.',
    );
    expect(html).toContain('char-reveal-char');
  });

  it('indexes every character against the paragraph’s length', () => {
    const chars = [...html.matchAll(/--c:\s*(\d+);--n:\s*(\d+)/g)];
    expect(chars.length).toBeGreaterThan(200);
    const lengths = new Set(chars.map((m) => m[2]));
    expect(lengths.size, 'one paragraph, so one --n').toBe(1);
    expect(chars[0]?.[1]).toBe('0');
  });

  /**
   * The fallback is the whole safety of this device. Full opacity is the DEFAULT
   * declaration, and the dimming only ever exists inside BOTH guards — so a
   * browser without scroll-driven animations, and a reader who asked for less
   * motion, get settled prose rather than a paragraph frozen at 20%.
   */
  it('dims a character only where scroll-driven animation exists AND motion is welcome', () => {
    const root = postcss.parse(CSS);
    const dimming: string[] = [];
    root.walkRules((rule) => {
      if (!rule.selector.includes('.char-reveal-char')) return;
      // Only the rule that turns the reveal ON — the print and reduced-motion
      // guards also name .char-reveal-char, to switch it off.
      const animates = rule.nodes.some(
        (node) =>
          node.type === 'decl' && node.prop === 'animation' && !node.value.startsWith('none'),
      );
      if (!animates) return;
      const guards: string[] = [];
      let parent: postcss.Container | postcss.Document | undefined = rule.parent;
      while (parent) {
        if (parent.type === 'atrule') {
          const at = parent as postcss.AtRule;
          guards.push(`@${at.name} ${at.params}`);
        }
        parent = parent.parent;
      }
      dimming.push(guards.join(' | '));
    });

    expect(dimming).toHaveLength(1);
    expect(dimming[0]).toContain('@supports (animation-timeline: view())');
    expect(dimming[0]).toContain('@media (prefers-reduced-motion: no-preference)');

    // Positive control: the keyframe that does the dimming really is 0.2 → 1, so
    // the guarded rule above is guarding something.
    expect(CSS).toMatch(/@keyframes char-lift \{\s*from \{ opacity: 0\.2; \}/);
  });
});

describe('/pricing — the tier cards have anatomy', () => {
  const html = pages['/pricing'];

  it('numbers the three tiers in ladder order, inside an ordered list', () => {
    expect(html).toContain('<ol');
    for (const [i, tier] of PLAN_TIERS_ORDERED.entries()) {
      // Split on the class attribute's closing quote, so the card's own parts
      // (numbered-card-head / -num / -list) do not each open a new slice.
      const card = html.split('numbered-card">')[i + 1] ?? '';
      expect(card).toContain(PLAN_DISPLAY[tier].name);
      expect(card).toContain(`0${i + 1}`);
    }
    expect(html.match(/numbered-card-num/g)).toHaveLength(PLAN_TIERS_ORDERED.length);
  });

  it('titles each card with its price and lists every feature as a check', () => {
    for (const tier of PLAN_TIERS_ORDERED) {
      for (const feature of PLAN_DISPLAY[tier].features) {
        expect(html).toContain(feature);
      }
    }
    expect(html.match(/numbered-card-list/g)).toHaveLength(PLAN_TIERS_ORDERED.length);
    // The lucide Check, once per feature line.
    const features = PLAN_TIERS_ORDERED.reduce(
      (total, tier) => total + PLAN_DISPLAY[tier].features.length,
      0,
    );
    expect(html.match(/lucide-check/g)).toHaveLength(features);
  });

  it('keeps the verified free-first copy exactly as it was reviewed', () => {
    const text = rawText(html).replace(/\s+/g, ' ');
    expect(text).toContain(
      'The whole core — every stage, every child — is free. Plus and Family add more of the work Hale does for you, on your approval, as each integration ships.',
    );
    expect(text).toContain(
      'The whole core is free. Paid plans are for the doing, never the watching.',
    );
    expect(text).toContain('Founding families join free.');
    expect(text).toContain(
      'Hale is free to start. Plus and Family open as their integrations ship.',
    );
  });

  it('drops the pre-pivot village headline', () => {
    expect(heading(html)).not.toContain('build the village');
    // Positive control: the headline is present and is the new one, so the
    // absence above is a real replacement rather than a missing <h1>.
    expect(rawText(heading(html))).toBe('Free while Hale is new.');
  });
});

describe('the pages keep the doors they had', () => {
  it('never points a reader at the wizard F14 deleted', () => {
    // /about closed on ${APP_URL}/onboarding — a 308 straight back to the
    // homepage, which made the About page's only action a loop.
    for (const [name, html] of Object.entries(pages)) {
      expect(html, `${name} must not link the deleted wizard`).not.toContain('/onboarding');
    }
    // Positive control: /about really does still close on an action.
    expect(pages['/about']).toContain('btn-on-navy');
  });

  it('keeps every page’s conversion CTA on the shared front door', () => {
    for (const [name, html] of Object.entries(pages)) {
      expect(html, `${name} must offer the chrome's CTA`).toMatch(/mailto:|sms:/);
    }
  });
});

describe('the policies stay quiet', () => {
  const legal = {
    '/privacy': privacyHtml,
    '/terms': termsHtml,
  };

  it('wears no headline reveal — one fade on the masthead is the whole motion', () => {
    for (const [name, html] of Object.entries(legal)) {
      expect(html, `${name} must not pull up its title`).not.toContain('pull-word');
      expect(html).toContain('legal-measure rise rise-1');
    }
  });

  it('holds the policy body to a reading measure', () => {
    expect(CSS).toMatch(/\.legal-measure \{ max-width: 38rem; \}/);
  });
});

describe('grain stays under the copy', () => {
  /**
   * The grain shipped once at full strength: `opacity: var(--grain-alpha)` where
   * the token was `light-dark(0.028, 0.045)`. `light-dark()` takes COLOURS, so as
   * a bare number it is invalid at computed-value time and opacity falls back to
   * its initial value of 1 — a grey noise field over the cream band, measured at
   * rgb(217,216,213) against the #f7f5f0 the token promised. Nothing warned: the
   * declaration parses, the token exists, and every test was green.
   *
   * So the pin is the shape rather than the number: the grain is printed as a
   * themed COLOUR through a noise mask, which is the only form in which a
   * light-dark() pair means what it says here.
   */
  it('is a themed ink at a few percent, never an opacity on a light-dark() number', () => {
    const opacityOnGrain: string[] = [];
    postcss.parse(CSS).walkDecls('opacity', (decl) => {
      if (decl.value.includes('--grain')) opacityOnGrain.push(decl.value);
    });
    expect(opacityOnGrain).toEqual([]);
    const ink =
      /--grain-ink: light-dark\(rgb\([^)]*\/\s*([\d.]+)\), rgb\([^)]*\/\s*([\d.]+)\)\);/.exec(CSS);
    if (!ink) throw new Error('--grain-ink is not declared as a light-dark() colour pair');
    for (const value of [ink[1], ink[2]]) {
      expect(Number(value)).toBeGreaterThan(0);
      expect(
        Number(value),
        'the mask averages half coverage, so keep the ink under 10%',
      ).toBeLessThan(0.1);
    }
    const rule = /\.grain::after \{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? '';
    expect(rule).toContain('background-color: var(--grain-ink)');
    expect(rule).toContain('mask-image: url("data:image/svg+xml');
    expect(rule).toContain('-webkit-mask-image: url("data:image/svg+xml');
  });

  it('paints behind the content and takes no clicks', () => {
    const rule = /\.grain::after \{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? '';
    expect(rule).toContain('z-index: -1');
    expect(rule).toContain('pointer-events: none');
    expect(rule).toContain('border-radius: inherit');
  });
});
