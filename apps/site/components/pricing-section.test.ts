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
    expect(french).toContain('Famille');
    expect(french).toContain('Tout ce qu’il y a dans Gratuit');
    expect(french).toContain('Tout ce qu’il y a dans Plus');
    expect(french).toContain('Rappels et brouillons, à mesure qu’ils arrivent');
    expect(french).toContain('La vue du foyer sur l’année, à mesure qu’elle arrive');
    expect(french).toContain('Conciergerie et soutien prioritaire');
    // TODO(VIL-367): FR card one-liners stay the previous translations until Design
    // locks the twins. Do not replace these with a translation of the English bytes.
    expect(french).toContain(
      'Textez Hale, dates d’inscription surveillées, réponses, et le tarif fondateur.',
    );
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
      family: 'Famille',
    });
  });

  it('renders Chinese tier names and paid features, not the English feature list', () => {
    // Plus and Family stay the names the rest of the zh pricing page already uses.
    // Free does not: the page says 免费, and the card was still saying Free.
    const chinese = renderToStaticMarkup(createElement(PricingSection, { locale: 'zh' }));
    expect(chinese).toContain('>免费<');
    expect(chinese).toContain('免费档的全部');
    expect(chinese).toContain('提醒和草稿，随这些部分陆续上线');
    expect(chinese).toContain('Plus 的全部');
    expect(chinese).toContain('专属礼宾和优先支持');
    expect(chinese).toContain('给 Hale 发短信');
    expect(chinese).not.toContain('Everything in Free');
    expect(chinese).not.toContain('Rec dates watched');
    expect(chinese).not.toContain('Founding rate');
    expect(chinese).not.toContain('>Free<');
    expect(zh.PricingSection.tierNames.free).toBe('免费');
    expect(zh.PricingSection.tierNames.plus).toBe('Plus');
    expect(zh.PricingSection.tierNames.family).toBe('Family');
  });

  it('shows both monthly and annual prices for the paid tiers', () => {
    expect(html).toContain('$9 CAD/mo');
    expect(html).toContain('$79 CAD/yr');
    expect(html).toContain('$19 CAD/mo');
    expect(html).toContain('$159 CAD/yr');
  });

  it('leads with the core being free, and argues it without a metaphor to decode', () => {
    expect(html).toContain('Free');
    expect(html).toContain('The whole core is free');
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
      free: 'Find what’s on and open the year. Watching mornings you’ve already set stays free.',
      plus: 'Nudges when a weekend’s empty or a waitlist opens — plus year memory as it ships.',
      family: 'One plan for the household. Co-parent stays in.',
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

  it('routes every tier to a LIVE action — no dead waitlist, checkout, or "Coming soon"', () => {
    expect(html).not.toContain('Coming soon');
    expect(html).not.toContain('#waitlist');
    expect(html.toLowerCase()).not.toContain('checkout');
    // Free and paid alike open the one front door the site chrome offers. There is one
    // CTA per tier, and all three carry the same destination — free vs paid differs in
    // emphasis (btn-primary vs btn-secondary), not in where it goes.
    const { href, label } = chromeCta();
    expect([...html.matchAll(new RegExp(escapeRe(href.replace(/&/g, '&amp;')), 'g'))]).toHaveLength(
      PLAN_TIERS_ORDERED.length,
    );
    expect([...html.matchAll(new RegExp(escapeRe(label), 'g'))]).toHaveLength(
      PLAN_TIERS_ORDERED.length,
    );
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

  it('carries the founding-families banner with the first-100 badge promise', () => {
    expect(html).toContain('Founding families join free.');
    expect(html).toContain('first 100 families get a permanent founding badge');
  });
});
