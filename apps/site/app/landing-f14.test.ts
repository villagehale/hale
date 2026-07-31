import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_URL } from '~/lib/app-url.js';
import { F14_LANDING_ENV } from '~/lib/flags/landing.js';
import { impactNumbers } from '~/lib/landing/impact.js';
import LandingPage from './page.js';

/**
 * VIL-250 · M14 — the persona-led landing pivot (D20/D21), behind
 * NEXT_PUBLIC_F14_LANDING. Dark: with the flag off the homepage is today's
 * village landing, which app/page.test.ts asserts in full against the
 * unmodified suite. This file owns the flag matrix and the flag-on page.
 *
 * The pivot's whole argument is that the only way in is texting Hale, so the
 * strongest assertions here are the negative ones: no signup funnel, no
 * capability claimed that isn't live, no placeholder metrics.
 */

const LIVE_NUMBER = '+16475551234';

/** The flag-on homepage, rendered with the number provisioned (the flip state). */
function renderOn({ number = LIVE_NUMBER }: { number?: string } = {}): string {
  vi.stubEnv(F14_LANDING_ENV, 'true');
  vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', number);
  return renderToStaticMarkup(createElement(LandingPage));
}

/** Visible text, tag-stripped — the village hero reveals word-by-word, one span each. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('homepage flag matrix', () => {
  it('serves today’s village landing when the flag is unset', () => {
    vi.stubEnv(F14_LANDING_ENV, '');
    const html = renderToStaticMarkup(createElement(LandingPage));
    expect(visibleText(html)).toContain('Parenting was never meant to be done alone.');
    expect(html).not.toContain('quiet chief of staff');
  });

  it('serves the chief-of-staff landing only for the exact literal', () => {
    for (const value of ['true\n', 'True', '1']) {
      vi.stubEnv(F14_LANDING_ENV, value);
      const html = renderToStaticMarkup(createElement(LandingPage));
      expect(visibleText(html)).toContain('Parenting was never meant to be done alone.');
      expect(html).not.toContain('quiet chief of staff');
    }
    expect(renderOn()).toContain('quiet chief of staff');
  });
});

describe('flag-on landing (hero)', () => {
  const html = renderOn();

  it('leads with the persona hero, verbatim', () => {
    expect(html).toContain('Hi, I’m Hale — your family’s quiet chief of staff.');
    expect(html).toContain(
      'I keep watch over your week — registrations, programs, school paperwork, weather — and text you before things matter.',
    );
  });

  it('has exactly one h1', () => {
    expect([...html.matchAll(/<h1[\s>]/g)]).toHaveLength(1);
  });

  it('makes "Text me" the sms: deep link into a pre-written first message', () => {
    // React escapes the `&` of the cross-platform `?&body=` form into `&amp;`.
    expect(html).toContain('href="sms:+16475551234?&amp;body=Hi"');
    expect(html).toContain('Text me');
  });

  it('covers desktop, where sms: links are dead, with the number and a scannable QR', () => {
    expect(html).toContain('+1 (647) 555-1234');
    expect(html).toContain('aria-label="QR code — scan to text Hale"');
  });
});

describe('flag-on landing (number not provisioned)', () => {
  const html = renderOn({ number: '' });

  it('never renders a dead sms: link or a number that cannot be texted', () => {
    expect(html).not.toContain('sms:');
    expect(html).not.toContain('Text me');
    expect(html).not.toContain('647');
  });

  it('falls back to the honest email path and says the number is not live', () => {
    expect(html).toContain('href="mailto:aloha@villagehale.com"');
    expect(html).toContain('The number’s coming');
  });
});

describe('flag-on landing (no signup funnel — the only way in is texting Hale)', () => {
  const html = renderOn();

  it('has no web signup funnel anywhere', () => {
    expect(html).not.toContain('/sign-up');
    expect(html).not.toContain('/onboarding');
    expect(html).not.toContain('/preview');
    for (const label of ['Get started', 'Sign up', 'Join free', 'Create an account']) {
      expect(html).not.toContain(label);
    }
  });

  it('keeps exactly one quiet Sign in link in the header, and one in the footer', () => {
    const header = html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? '';
    expect([...header.matchAll(/\/sign-in"/g)]).toHaveLength(1);
    expect([...html.matchAll(/\/sign-in"/g)]).toHaveLength(2);
    expect(header).toContain(`href="${APP_URL}/sign-in"`);
  });
});

describe('flag-on landing (sections, in the Surfaces Plan order)', () => {
  const html = renderOn();
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  it('names all eight municipalities it watches', () => {
    for (const city of [
      'Toronto',
      'Markham',
      'Vaughan',
      'Richmond Hill',
      'Mississauga',
      'Oakville',
      'Burlington',
      'Halton Hills',
    ]) {
      expect(text).toContain(city);
    }
  });

  it('tells the three texts and the suggest → prepare → handle ladder with receipts', () => {
    expect(text).toContain('You say hi');
    expect(text).toContain('I send your family’s radar');
    expect(text).toContain('I keep watch');
    expect(text).toContain('I suggest');
    expect(text).toContain('I prepare');
    expect(text).toContain('with your ok, I handle it');
    expect(text.toLowerCase()).toContain('receipts');
  });

  it('covers the village and the co-parent, and keeps the roles honest', () => {
    expect(text).toContain('just the schedule');
    expect(text).toContain('co-parent');
  });

  it('makes the privacy claim Canadian and links the policy page', () => {
    expect(text).toContain('stays in Canada');
    expect(html).toContain('href="/privacy"');
  });

  it('offers the founding rate without inventing urgency', () => {
    expect(text).toContain('Founding families');
    for (const pressure of ['Only', 'spots left', 'Hurry', 'ends soon', 'Limited time']) {
      expect(text).not.toContain(pressure);
    }
  });

  it('sends questions to the single canonical FAQ instead of duplicating it', () => {
    expect(html).toContain('href="/faq"');
  });

  it('orders the sections the way the Surfaces Plan does', () => {
    const order = [
      'quiet chief of staff',
      'What I watch',
      'How I work',
      'Your village',
      'the Canadian way',
      'Founding families',
    ].map((marker) => text.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('flag-on landing (impact numbers — honesty rule)', () => {
  it('has no metrics wired yet, so the band is omitted rather than zeroed', () => {
    expect(impactNumbers()).toBeNull();
    const text = renderOn()
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
    for (const label of ['families covered', 'registrations caught', 'weeks planned']) {
      expect(text).not.toContain(label);
    }
  });
});

describe('flag-on landing (the transcript is the real script)', () => {
  const html = renderOn();

  it('plays the first-10-minutes script from the Conversation Design book', () => {
    expect(html).toContain(
      'Hi, I’m Hale — I keep family weeks on track for GTA parents. What are your kids’ names and ages — and what’s your postal code?',
    );
    expect(html).toContain('I’m an assistant, not a person');
    expect(html).toContain('Max is 4, Mia is 18 months, L4C');
    expect(html).toContain(
      'Richmond Hill fall swim registration opens Tue Aug 12, 7:00 a.m. — spots for Max’s age usually go in minutes.',
    );
    expect(html).toContain('Done — you’re covered. I’ll only text when something actually matters.');
  });

  it('labels the thread as an example rather than passing it off as a screenshot', () => {
    expect(html.toLowerCase()).toContain('example');
    expect(html).not.toContain('<img');
  });
});
