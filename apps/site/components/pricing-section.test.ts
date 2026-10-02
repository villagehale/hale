import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromeCta } from '~/lib/site/chrome-cta.js';
import en from '../messages/en.json';
import fr from '../messages/fr.json';
import zh from '../messages/zh.json';
import { PricingSection } from './pricing-section.js';

/**
 * Pricing is one fact: Hale is free, with unlimited chat. Paid tiers are not
 * live, so the section must not render a Free/Plus/Family table, a price, or
 * an upgrade. One card, one text door.
 */
const html = renderToStaticMarkup(createElement(PricingSection));

/** Escape a string for use inside a RegExp — hrefs carry `+`, `?` and `.`. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PricingSection (landing pricing)', () => {
  it('states the free chat in one card, with no tier table and no price', () => {
    expect(en.PricingSection.freeLine).toBe('Free');
    expect(en.PricingSection.freeFeatures).toEqual([
      'Unlimited chat',
      'Live find',
      'A text when a place opens',
      'iMessage',
    ]);
    expect(html).toContain('Free, with unlimited chat.');
    expect(html).toContain('Unlimited chat');
    expect(html).not.toContain('Plus');
    expect(html).not.toContain('Family');
    expect(html).not.toContain('$');
    expect(html).not.toContain('Founding');
    expect(html).not.toContain('Coming soon');
    expect(html).not.toContain('Subscribe');
    expect([...html.matchAll(/numbered-card-list/g)]).toHaveLength(1);
    expect([...html.matchAll(/lucide-check/g)]).toHaveLength(en.PricingSection.freeFeatures.length);
  });

  it('renders the French free card, not a paid-tier list', () => {
    const french = renderToStaticMarkup(createElement(PricingSection, { locale: 'fr' }));
    expect(french).toContain('Gratuit, avec un clavardage illimite.');
    expect(french).toContain('Clavardage illimite');
    expect(french).toContain('Recherche en direct');
    expect(french).not.toContain('Plus');
    expect(french).not.toContain('Famille');
    expect(french).not.toContain('$');
    expect(french).not.toContain('Founding rate');
    expect(fr.PricingSection.freeLine).toBe('Gratuit');
    expect(fr.PricingSection.freeFeatures).toEqual([
      'Clavardage illimite',
      'Recherche en direct',
      'Un texto quand une place s\'ouvre',
      'iMessage',
    ]);
  });

  it('renders the Chinese free card, not Plus or Family', () => {
    const chinese = renderToStaticMarkup(createElement(PricingSection, { locale: 'zh' }));
    expect(chinese).toContain('免费，聊天不限次数。');
    expect(chinese).toContain('聊天不限次数');
    expect(chinese).not.toContain('Plus');
    expect(chinese).not.toContain('Family');
    expect(chinese).not.toContain('$');
    expect(chinese).not.toContain('创始价');
    expect(zh.PricingSection.freeLine).toBe('免费');
  });

  it('argues the price without a metaphor to decode', () => {
    const argument = html
      .replace(/<ul class="numbered-card-list">[\s\S]*?<\/ul>/g, '')
      .replace(/<[^>]+>/g, ' ');
    expect(argument).toContain('There is no paid plan');
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
