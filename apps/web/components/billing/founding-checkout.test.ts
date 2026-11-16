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
  it('shows the Canadian price, recurrence, refund and Plus line before Stripe', () => {
    const body = text(
      renderToStaticMarkup(
        createElement(FoundingCheckout, {
          currency: 'CAD',
          phase: 'black_friday',
          ready: true,
          attribution: {},
        }),
      ),
    );
    expect(body).toContain('Black Friday Sale');
    expect(body).toContain('Billed C$79/yr in CAD, starting today.');
    expect(body).toContain('Renews once a year at the same price while you stay subscribed.');
    expect(body).toContain('Refund anytime.');
    expect(body).toContain('Plus is C$159/yr after Dec 31.');
    expect(body).toContain('Continue to checkout · C$79/yr');
    expect(body).not.toMatch(/\bsave\b|% ?off|\bwas\b/i);
  });

  it('shows the US price without the Canadian line and disables an unready checkout', () => {
    const html = renderToStaticMarkup(
      createElement(FoundingCheckout, {
        currency: 'USD',
        phase: 'holiday',
        ready: false,
        attribution: {},
      }),
    );
    const body = text(html);
    expect(body).toContain('Holiday Sale');
    expect(body).toContain('Billed US$59/yr in USD, starting today.');
    expect(body).not.toContain('C$159');
    expect(body).toContain('Checkout isn’t open yet. You haven’t been charged.');
    expect(html).toMatch(/<button[^>]*disabled/);
  });
});
