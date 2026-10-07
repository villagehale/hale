import { PLAN_DISPLAY, PLAN_TIERS_ORDERED } from '@hale/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    // VIL-367 FR twins, Sloane + Miles 2026-09-23. Exact bytes.
    const lockedFr = {
      free: 'Trouvez ce qu’il y a et ouvrez l’année. Les matins que vous surveillez déjà restent gratuits.',
      plus: 'Des rappels quand un week-end est vide ou qu’une liste d’attente s’ouvre — plus la mémoire de l’année, à mesure qu’elle arrive.',
      family: 'Un plan pour le foyer. Le coparent reste dedans.',
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

  it('shows current CAD prices, annual savings, and real entitlements', () => {
    for (const price of ['$19 CAD/mo', '$159 CAD/yr', '$39 CAD/mo', '$329 CAD/yr'])
      expect(html).toContain(price);
    for (const tier of PLAN_TIERS_ORDERED)
      for (const feature of PLAN_DISPLAY[tier].features) expect(html).toContain(feature);
    for (const tier of ['plus', 'family'] as const) {
      const plan = PLAN_DISPLAY[tier];
      const saved = 12 - plan.annualPriceCad / plan.monthlyPriceCad;
      expect(saved).toBeGreaterThanOrEqual(3);
      expect(saved).toBeLessThan(4);
    }
    expect(html).toContain('about three months free');
  });

  it('only Free opens a texting door; paid tiers cannot start checkout', () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');
    const live = renderToStaticMarkup(createElement(PricingSection));
    expect(live.match(/href="\/text"/g)).toHaveLength(1);
    expect(live.match(/<button[^>]*disabled/g)).toHaveLength(2);
    expect(live.match(/Coming soon/g)).toHaveLength(2);
    expect(live).toContain('Only Free is available today.');
    expect(live).not.toMatch(/checkout|onboarding|#waitlist|href="sms:/);
  });
});
