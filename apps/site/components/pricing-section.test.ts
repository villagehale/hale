import { PLAN_DISPLAY, PLAN_TIERS_ORDERED } from '@hale/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromeCta } from '~/lib/site/chrome-cta.js';
import en from '../messages/en.json';
import fr from '../messages/fr.json';
import zh from '../messages/zh.json';
import { PricingSection } from './pricing-section.js';

/**
 * The landing pricing section renders the three tiers from the shared display
 * source, free-leads, with both monthly and annual prices shown and a free-to-start
 * framing. Rendered to static markup — the section is a pure server component.
 */
const html = renderToStaticMarkup(createElement(PricingSection));

/** Escape a string for use inside a RegExp — hrefs carry `+`, `?` and `.`. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PricingSection (landing pricing)', () => {
  it('keeps the English names and feature lines equal to PLAN_DISPLAY', () => {
    // The English card reads the message bundle, not PLAN_DISPLAY directly, so
    // this is the pin that stops the site drifting from the app.
    expect(en.PricingSection.tierNames).toEqual({
      free: PLAN_DISPLAY.free.name,
      plus: PLAN_DISPLAY.plus.name,
      family: PLAN_DISPLAY.family.name,
    });
    expect(en.PricingSection.paidFeatures.plus).toEqual([...PLAN_DISPLAY.plus.features]);
    expect(en.PricingSection.paidFeatures.family).toEqual([...PLAN_DISPLAY.family.features]);
    expect(en.PricingSection.freeFeatures).toEqual([...PLAN_DISPLAY.free.features]);
  });

  it('renders all three tiers with their display names', () => {
    expect(html).toContain(PLAN_DISPLAY.free.name);
    expect(html).toContain(PLAN_DISPLAY.plus.name);
    expect(html).toContain(PLAN_DISPLAY.family.name);
  });

  it('renders French tier names and paid features, not the English list', () => {
    const french = renderToStaticMarkup(createElement(PricingSection, { locale: 'fr' }));
    expect(french).toContain('Gratuit');
    expect(french).toContain('>Max<');
    expect(french).not.toContain('Famille');
    expect(french).toContain('Tout ce qu’il y a dans Gratuit');
    expect(french).toContain('Tout ce qu’il y a dans Plus');
    expect(french).toContain('Un petit coup de pouce quand la fin de semaine est vide');
    expect(french).toContain('Les limites les plus hautes pour les recherches et la surveillance des places');
    expect(french).toContain('Soutien prioritaire');
    expect(french).toContain('Les inscriptions de toute une saison, d’un coup');
    const lockedFr = {
      free: 'Trouvez ce qu’il y a et ouvrez l’année. Les matins que vous surveillez déjà restent gratuits.',
      plus: 'Plus de choses faites pour toi, toute l’année.',
      family: 'Le maximum de ce que Hale peut faire.',
    } as const;
    expect(fr.PricingSection.tierLines).toEqual(lockedFr);
    for (const line of Object.values(lockedFr)) {
      expect(french).toContain(line);
    }
    expect(french).not.toContain('Find what’s on and open the year.');
    // Free-tier bullets stay the French marketing list.
    expect(french).toContain('Textez Hale');
    expect(french).toContain('Dates d’inscription surveillées');
    expect(french).not.toContain('Everything in Free');
    expect(french).not.toContain('Everything in Plus');
    expect(french).not.toContain('Rec dates watched');
    expect(french).not.toContain('Founding rate');
    expect(french).not.toContain('>Free<');
    expect(french).not.toContain('>Family<');
    expect(fr.PricingSection.tierNames).toEqual({
      free: 'Gratuit',
      plus: 'Plus',
      family: 'Max',
    });
    expect(french).toContain('$19 CAD/mo');
    expect(french).toContain('$159 CAD/yr');
    expect(french).toContain('$39 CAD/mo');
    expect(french).toContain('$329 CAD/yr');
    expect(french).toContain('Seul Gratuit est disponible aujourd’hui.');
    expect(french).toContain('Bientôt disponible');
    expect([...french.matchAll(/disabled/g)]).toHaveLength(2);
    expect([...french.matchAll(/Bientôt disponible/g)]).toHaveLength(2);
  });

  it('renders Chinese tier names and paid features, not the English feature list', () => {
    // Plus stays the name the rest of the zh pricing page already uses. The
    // family tier displays as Max. Free is 免费, not the English Free.
    const chinese = renderToStaticMarkup(createElement(PricingSection, { locale: 'zh' }));
    expect(chinese).toContain('>免费<');
    expect(chinese).toContain('免费档里的全部');
    expect(chinese).toContain('周末空着的时候提你一句');
    expect(chinese).toContain('Plus 里的全部');
    expect(chinese).toContain('搜索和盯名额，额度最高');
    expect(chinese).toContain('优先支持');
    expect(chinese).toContain('一整季的报名，一次办完');
    expect(chinese).toContain('给 Hale 发短信');
    expect(chinese).not.toContain('Everything in Free');
    expect(chinese).not.toContain('Rec dates watched');
    expect(chinese).not.toContain('Founding rate');
    expect(chinese).not.toContain('>Free<');
    expect(zh.PricingSection.tierNames.free).toBe('免费');
    expect(zh.PricingSection.tierNames.plus).toBe('Plus');
    expect(zh.PricingSection.tierNames.family).toBe('Max');
    expect(chinese).toContain('>Max<');
    expect(chinese).not.toContain('Family');
    expect(chinese).toContain('$19 CAD/mo');
    expect(chinese).toContain('$159 CAD/yr');
    expect(chinese).toContain('$39 CAD/mo');
    expect(chinese).toContain('$329 CAD/yr');
    expect(chinese).toContain('目前只有免费档可用。');
    expect([...chinese.matchAll(/即将推出/g)]).toHaveLength(2);
    expect([...chinese.matchAll(/disabled/g)]).toHaveLength(2);
  });

  it('shows both monthly and annual prices for the paid tiers', () => {
    expect(html).toContain('$0 CAD/mo');
    expect(html).toContain('$19 CAD/mo');
    expect(html).toContain('$159 CAD/yr');
    expect(html).toContain('$39 CAD/mo');
    expect(html).toContain('$329 CAD/yr');
  });

  it('leads with the core being free, and argues it without a metaphor to decode', () => {
    expect(html).toContain('Free');
    expect(html).toContain('Only Free is available today.');
    // "The village" as a synonym for Hale was a third governing metaphor at the
    // close (after chief of staff and radar) — a word the reader has to translate
    // before learning the price. It is earned in exactly one place now: the About
    // page's story of the village we lost. The tier FEATURE lines are a different
    // thing — they name the shipped family-to-family Village product — so the
    // assertion is against the band's own argument, not the feature list.
    const argument = html
      .replace(/<ul class="numbered-card-list">[\s\S]*?<\/ul>/g, '')
      // Visible prose only — the brand domain lives in an href, not in the argument.
      .replace(/<[^>]+>/g, ' ');
    expect(argument).not.toContain('village');
  });

  it('states the locked year-attention one-liners, not Village or Companion', () => {
    // VIL-367, Sloane + Miles 2026-09-23. Exact bytes — the cards must not paraphrase.
    const locked = {
      free: 'Unlimited chat, on your own or in your group chats. Hale finds what’s on, watches for spots and reminds you before sign-ups.',
      plus: 'More done for you, all year.',
      family: 'The most Hale can do.',
    } as const;
    expect(en.PricingSection.tierLines).toEqual(locked);
    for (const line of Object.values(locked)) {
      expect(html).toContain(line);
    }
    // Paid is year-attention packaging. It does not meter finds, sell a watch YES,
    // pull travel forward, or open a live checkout.
    const joined = Object.values(locked).join('\n');
    expect(joined).not.toMatch(/\d+\s+finds?\b/i);
    expect(joined.toLowerCase()).not.toContain('reply yes');
    expect(joined.toLowerCase()).not.toContain('travel');
    expect(html).not.toContain('Subscribe');
    expect(html).not.toContain('see what families near you recommend');
    expect(html).not.toContain('Your village feed');
    expect(html).not.toContain('Companion:');
  });

  it('opens the composer on Free only — Plus and Max say Coming soon', () => {
    expect(html).toContain('Coming soon');
    expect([...html.matchAll(/Coming soon/g)]).toHaveLength(2);
    expect(html).not.toContain('#waitlist');
    expect(html.toLowerCase()).not.toContain('checkout');
    const { href, label } = chromeCta();
    expect([...html.matchAll(new RegExp(escapeRe(href.replace(/&/g, '&amp;')), 'g'))]).toHaveLength(1);
    expect([...html.matchAll(new RegExp(`>${escapeRe(label)}<`, 'g'))]).toHaveLength(1);
  });

  /**
   * The regression this replaced a label-pin with. Every tier CTA used to hardcode the
   * app's /onboarding wizard, which no longer exists — so the pricing page's only
   * action 308'd the reader back to the marketing homepage. Asserted under the LIVE
   * config, because that is what a reader actually gets.
   */
  it('sends a reader to the texting door under the live config — never the deleted wizard', () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');
    const live = renderToStaticMarkup(createElement(PricingSection));
    expect(chromeCta().href).toMatch(/^sms:/);
    expect(live).toContain('sms:+16475551234');
    expect(live).not.toContain('/onboarding');
  });

  it('claims an annual discount the prices actually deliver', () => {
    // It said "about two months free" while $79 vs $9x12 saves 3.2 months and
    // $159 vs $19x12 saves 3.6 — wrong for both tiers, on the one page a reader
    // checks the arithmetic on. Derived from PLAN_DISPLAY, so a reprice that
    // makes the sentence untrue fails here rather than shipping.
    const CLAIMED_MONTHS = 3;
    const paid = PLAN_TIERS_ORDERED.filter((tier) => PLAN_DISPLAY[tier].monthlyPriceCad > 0);
    expect(paid.length).toBeGreaterThan(0);
    for (const tier of paid) {
      const plan = PLAN_DISPLAY[tier];
      const saved = (plan.monthlyPriceCad * 12 - plan.annualPriceCad) / plan.monthlyPriceCad;
      expect(saved, `${tier} saves less than the page claims`).toBeGreaterThanOrEqual(
        CLAIMED_MONTHS,
      );
      expect(saved, `${tier} saves a whole month more than the page claims`).toBeLessThan(
        CLAIMED_MONTHS + 1,
      );
    }
    expect(html).toContain('about three months free');
  });

  it('carries the founding-families note for every family until paid plans start', () => {
    expect(html).not.toMatch(/keep\s+their\s+rate/);
    expect(html).toContain('Founding families get every feature free until paid plans start.');
    expect(html).not.toMatch(/first\s+100/);
    expect(html).not.toMatch(/founding\s+badge/);
  });
});
