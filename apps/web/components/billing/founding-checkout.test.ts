/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoundingCheckout } from './founding-checkout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    expect(body).toContain('Holiday Sale');
    expect(body).not.toMatch(/Cyber Monday|Black Friday/);
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

  describe('when the server refuses the offer', () => {
    let root: ReturnType<typeof createRoot> | null = null;

    afterEach(() => {
      root?.unmount();
      root = null;
      document.body.replaceChildren();
      vi.unstubAllGlobals();
    });

    it('says this offer is unavailable, with no founding wording', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: 'founding_unavailable' }), { status: 409 }),
        ),
      );
      const container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root?.render(
          createElement(FoundingCheckout, {
            currency: 'CAD',
            phase: 'holiday',
            ready: true,
            attribution: {},
            tier: 'plus',
          }),
        );
      });
      await act(async () => {
        (container.querySelector('button') as HTMLButtonElement).click();
      });

      expect(container.textContent).toContain(
        'This offer isn’t available right now. Please try again later.',
      );
      expect(container.textContent).not.toMatch(/founding/i);
    });
  });
});
