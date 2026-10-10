import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLAN_DISPLAY, PLAN_TIERS_ORDERED } from '@hale/types';
import postcss from 'postcss';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AboutPage from './[locale]/about/page.js';
import ActivitiesHub from './[locale]/activities/page.js';
import AnswerRoute from './[locale]/answers/[slug]/page.js';
import AnswersIndexPage from './[locale]/answers/page.js';
import ContactPage from './[locale]/contact/page.js';
import FaqPage from './[locale]/faq/page.js';
import PricingPage from './[locale]/pricing/page.js';
import PrivacyPage from './[locale]/privacy/page.js';
import TermsPage from './[locale]/terms/page.js';

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
const privacyHtml = await renderAsync(PrivacyPage({ params: Promise.resolve(EN) }));
const termsHtml = await renderAsync(TermsPage({ params: Promise.resolve(EN) }));

/** The eight pages that wear the pulled-up headline, and the sentence each must
 * still read as once the words are split apart. */
const REDESIGN_H1: [name: string, html: string, headline: string][] = [
  ['/about', pages['/about'], 'A planner for your kids’ year.'],
  ['/pricing', pages['/pricing'], 'Free, with unlimited chat.'],
  ['/faq', pages['/faq'], 'Is Hale right for your family?'],
  ['/contact', pages['/contact'], 'Say hello.'],
  ['/answers', pages['/answers'], 'Calm, cited guidance for every stage.'],
  ['/activities', pages['/activities'], 'Things to do with your kids, near you.'],
];

describe('the redesign headlines', () => {
  it.each(REDESIGN_H1)('reads as its whole sentence on %s', (_name, html, headline) => {
    expect(rawText(heading(html)).replace(/\u00a0/g, ' ')).toBe(headline);
    expect(html).toContain('sp-h1');
    expect(html).not.toContain('pull-word');
  });
});

describe('the guide headline', () => {
  it('is the question in plain navy, inside the redesign, with no accent word', () => {
    const h1 = heading(slugHtml);
    expect(rawText(h1)).toBe('When and how do I introduce peanuts to my baby?');
    expect(h1).not.toContain('pull-word');
    expect(h1).not.toContain('v4-accent');
    expect(slugHtml).toContain('class="rd"');
    expect(slugHtml).toContain('gd-h1');
    expect(slugHtml).not.toContain('panel-apricot-tint');
    expect(slugHtml).not.toContain('class="night');
    expect(slugHtml).not.toContain('WordsPullUp');
  });

  it('leaves the homepage on its own hero display, not the subpage reveal', () => {
    // Home is the liquid-glass shore: its hero display is set large
    // (.v4-display / .v4-hero-h1), not the subpage pulled-up reveal. The two
    // never share the pull-word device — only the amber accent.
    const landing = readFileSync(
      fileURLToPath(new URL('../components/redesign/home.tsx', import.meta.url)),
      'utf8',
    );
    expect(landing).not.toContain('pull-word');
    expect(landing).not.toContain('WordsPullUp');
    expect(landing).toContain('className="hero"');
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

describe('/about — the locked page', () => {
  const html = pages['/about'];

  it('says why now, and drops the old framing', () => {
    const text = rawText(html);
    expect(text.replace(/\u00a0/g, ' ')).toContain('Parent-built in Georgetown, Ontario.');
    expect(text).toContain('Every parent should have someone who knows what’s on near them');
    expect(text).not.toMatch(/agentic|Anzhe/i);
    expect(text).not.toMatch(/equity|ownership|cap table|cap-table/i);
  });

  it('opens on the approved story line', () => {
    expect(rawText(html)).toContain('Two parents building the helper we wanted.');
    expect(rawText(html)).not.toContain('You register, and nothing happens without a yes');
  });

  it('lines up two founders, Barton and Eugene, with initials and LinkedIn text links', () => {
    const text = rawText(html);
    expect(text).toContain('Barton Dong');
    expect(text).toContain('Eugene Song');
    expect(text.indexOf('Barton Dong')).toBeLessThan(text.indexOf('Eugene Song'));
    expect(text).toContain('CEO');
    expect(text).toContain('CTO');
    expect(text).not.toContain('Anzhe');
    expect(html).toContain('href="https://linkedin.com/in/anzhe-dong"');
    expect(html).toContain('href="https://www.linkedin.com/in/yuhang-eugene-song-53b692172"');
    expect(html).not.toContain('media.licdn.com');
    expect(html).not.toContain('linkedin.com/dms');
    expect(html).not.toContain('x.com/therealbossdong');
    expect(html).not.toContain('github.com/donganzh');
    expect(html).toContain('>BD<');
    expect(html).toContain('>ES<');
    expect(html).not.toContain('founder-portrait');
    expect(html.match(/>LinkedIn</g)).toHaveLength(2);
  });

  it('hosts both portraits at 96px, the same square, and does not zoom them', () => {
    function jpegSize(buf: Buffer): { width: number; height: number } {
      // SOF0 / SOF2: marker, length, precision, height, width.
      let offset = 2;
      while (offset < buf.length) {
        if (buf[offset] !== 0xff) break;
        const marker = buf[offset + 1] ?? 0;
        const length = buf.readUInt16BE(offset + 2);
        if (marker === 0xc0 || marker === 0xc2) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
      throw new Error('no JPEG frame');
    }
    const assets = ['founder-barton-dong.jpg', 'founder-eugene-song.jpg'] as const;
    const sizes = assets.map((name) =>
      jpegSize(readFileSync(fileURLToPath(new URL(`../assets/${name}`, import.meta.url)))),
    );
    expect(sizes).toEqual([
      { width: 96, height: 96 },
      { width: 96, height: 96 },
    ]);
  });

  it('names Barton and Eugene in every locale, and never Anzhe or an ownership claim', () => {
    for (const locale of ['en', 'fr', 'zh'] as const) {
      const about = JSON.parse(
        readFileSync(fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)), 'utf8'),
      ).About as {
        metaDescription: string;
        lede: string;
        headline: { text: string }[];
        founders: { name: string; role: string }[];
      };
      const copy = JSON.stringify(about);
      const names = about.founders.map((founder) => founder.name);
      expect(names).toEqual(['Barton Dong', 'Eugene Song']);
      expect(about.metaDescription).toContain('Barton Dong');
      expect(about.metaDescription).toContain('Eugene Song');
      expect(copy).not.toMatch(
        /Anzhe|agentic|agentique|智能体|equity|ownership|cap table|cap-table/,
      );
      expect(about.headline.map((segment) => segment.text).join(' ')).not.toMatch(
        /not another app|pas une autre appli|又一个应用/,
      );
    }
  });
});

describe('/pricing — the tier cards have anatomy', () => {
  const html = pages['/pricing'];

  it('names the three tiers in ladder order', () => {
    let cursor = 0;
    for (const tier of PLAN_TIERS_ORDERED) {
      const at = html.indexOf(PLAN_DISPLAY[tier].name, cursor);
      expect(at, PLAN_DISPLAY[tier].name).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(html).toContain('$0');
    expect(html).toContain('$19');
    expect(html).toContain('$39');
    expect(html).toContain('CAD/mo');
  });

  it('lists every shipped feature, and marks Plus and Max coming soon', () => {
    for (const tier of PLAN_TIERS_ORDERED) {
      for (const feature of PLAN_DISPLAY[tier].features) {
        expect(rawText(html)).toContain(feature);
      }
    }
    expect(html.match(/Coming soon/g)).toHaveLength(2);
    expect(html).toContain('>Text Hale<');
  });

  it('keeps the free-first footnote', () => {
    const text = rawText(html).replace(/\s+/g, ' ');
    expect(text).toContain('Only Free is available today.');
    expect(text).toContain('Founding families join free.');
    expect(text).toContain('about three months free');
  });

  it('drops the pre-pivot village headline', () => {
    expect(heading(html)).not.toContain('build the village');
    // Positive control: the headline is present and is the new one, so the
    // absence above is a real replacement rather than a missing <h1>.
    expect(rawText(heading(html)).replace(/\u00a0/g, ' ')).toBe('Free, with unlimited chat.');
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
    expect(pages['/about']).toContain('Text Hale');
  });

  it('keeps every page’s conversion CTA on the shared front door', () => {
    for (const [name, html] of Object.entries(pages)) {
      expect(html, `${name} must offer the chrome's CTA`).toMatch(/mailto:|sms:|href="\/text/);
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
      expect(html).toContain('sp-legal');
      expect(html).toContain('lg-toc');
      expect(html).not.toContain('hs-close');
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
