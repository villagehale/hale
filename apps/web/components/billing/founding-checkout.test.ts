import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FoundingCheckout } from './founding-checkout';

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('FoundingCheckout', () => {
  it('shows the Canadian Plus price, recurrence, refund and no CAD label before Stripe', () => {
    const body = text(
      renderToStaticMarkup(
        createElement(FoundingCheckout, {
          currency: 'CAD',
          phase: 'black_friday',
          ready: true,
          attribution: {},
          tier: 'plus',
        }),
      ),
    );
    expect(body).toContain('Black Friday Sale');
    expect(body).toContain('Plus');
    expect(body).toContain('Billed $59/yr, starting today.');
    expect(body).toContain('Renews once a year at the same price while you stay subscribed.');
    expect(body).toContain('Refund anytime.');
    expect(body).not.toMatch(/\$159|after Dec 31/);
    expect(body).toContain('Continue to checkout · $59/yr');
    expect(body).not.toMatch(/\bsave\b|% ?off|\bwas\b/i);
    expect(body).not.toMatch(/C\$|US\$/);
    expect(body).not.toMatch(/\bCAD\b|\bUSD\b/);
  });

  it('shows the US Max price without a currency code and disables an unready checkout', () => {
    const html = renderToStaticMarkup(
      createElement(FoundingCheckout, {
        currency: 'USD',
        phase: 'holiday',
        ready: false,
        attribution: {},
        tier: 'family',
      }),
    );
    const body = text(html);
    expect(body).toContain('Holiday Sale');
    expect(body).toContain('Max');
    expect(body).toContain('Billed $79/yr, starting today.');
    expect(body).not.toContain('$159');
    expect(body).not.toMatch(/\bCAD\b|\bUSD\b/);
    expect(body).not.toMatch(/C\$|US\$/);
    expect(body).toContain('Checkout isn’t open yet. You haven’t been charged.');
    expect(html).toMatch(/<button[^>]*disabled/);
  });
});
