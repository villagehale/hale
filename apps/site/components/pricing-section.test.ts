import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromeCta } from '~/lib/site/chrome-cta.js';
import en from '../messages/en.json';
import fr from '../messages/fr.json';
import zh from '../messages/zh.json';
import { PricingSection } from './pricing-section.js';

/**
 * Three cards. Free is the only live tier and the only text door. Plus and
 * Family say they are coming soon. No price, no founding rate, no upgrade.
 */
const html = renderToStaticMarkup(createElement(PricingSection));

/** Escape a string for use inside a RegExp — hrefs carry `+`, `?` and `.`. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PricingSection (landing pricing)', () => {
  it('states free chat as the live card, and paid tiers as coming soon, with no price', () => {
    expect(en.PricingSection.freeLine).toBe('Free');
    expect(en.PricingSection.comingSoon).toBe('Coming soon');
    expect(en.PricingSection.freeFeatures).toEqual([
      'Unlimited chat',
      'Live find',
      'A text when a place opens',
      'iMessage',
    ]);
    expect(html).toContain('Free, with unlimited chat.');
    expect(html).toContain('Unlimited chat');
    expect(html).toContain('Plus');
    expect(html).toContain('Family');
    expect([...html.matchAll(/Coming soon/g)]).toHaveLength(2);
    expect(html).not.toContain('$');
    expect(html).not.toContain('Founding');
    expect(html).not.toContain('Subscribe');
    expect(html).not.toContain('There is no price');
    expect(html).not.toContain('Your data stays in Canada');
    expect([...html.matchAll(/class="v4-tier"/g)]).toHaveLength(3);
    expect(html).not.toContain('numbered-card-list');
  });

  it('renders the French cards: Gratuit is live, Plus and Famille are coming soon', () => {
    const french = renderToStaticMarkup(createElement(PricingSection, { locale: 'fr' }));
    expect(french).toContain('Gratuit, avec un clavardage illimité.');
    expect(french).toContain('Clavardage illimité');
    expect(french).toContain('Recherche en direct');
    expect(french).toContain('Plus');
    expect(french).toContain('Famille');
    expect([...french.matchAll(/Bientôt/g)]).toHaveLength(2);
    expect(french).not.toContain('$');
    expect(french).not.toContain('Founding rate');
    expect(french).not.toContain('Pas de prix');
    expect(fr.PricingSection.freeLine).toBe('Gratuit');
    expect(fr.PricingSection.comingSoon).toBe('Bientôt');
    expect(fr.PricingSection.freeFeatures).toEqual([
      'Clavardage illimité',
      'Recherche en direct',
      "Un texto quand une place s'ouvre",
      'iMessage',
    ]);
  });

  it('renders the Chinese cards: free is live, Plus and Family are coming soon', () => {
    const chinese = renderToStaticMarkup(createElement(PricingSection, { locale: 'zh' }));
    expect(chinese).toContain('免费，聊天不限次数。');
    expect(chinese).toContain('聊天不限次数');
    expect(chinese).toContain('Plus');
    expect(chinese).toContain('Family');
    expect([...chinese.matchAll(/即将推出/g)]).toHaveLength(2);
    expect(chinese).not.toContain('$');
    expect(chinese).not.toContain('创始价');
    expect(zh.PricingSection.freeLine).toBe('免费');
  });

  it('names the live tier without a price and without a metaphor', () => {
    const argument = html.replace(/<[^>]+>/g, ' ');
    expect(argument).toContain('Only Free is available today.');
    expect(argument).not.toContain('There is no price');
    expect(argument).not.toContain('village');
  });

  it('routes the one card to the texting door — never a checkout', () => {
    expect(html.toLowerCase()).not.toContain('checkout');
    expect(html).not.toContain('#waitlist');
    const { href, label } = chromeCta();
    expect([...html.matchAll(new RegExp(escapeRe(href.replace(/&/g, '&amp;')), 'g'))]).toHaveLength(1);
    expect([...html.matchAll(new RegExp(escapeRe(label), 'g'))]).toHaveLength(1);
  });

  it('sends a reader to the texting door under the live config — never the deleted wizard', () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');
    const live = renderToStaticMarkup(createElement(PricingSection));
    expect(chromeCta().href).toMatch(/^sms:/);
    expect(live).toContain('sms:+16475551234');
    expect(live).not.toContain('/onboarding');
  });
});
