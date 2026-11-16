import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FoundingJoinForm } from './founding-join-form';
import { FreeJoinCard } from './free-join-card';

describe('FoundingJoinForm', () => {
  it('shows a plain $ price, the currency note, and a full refund anytime', () => {
    const html = renderToStaticMarkup(
      createElement(FoundingJoinForm, { priceLabel: '$79/yr', currency: 'CAD' }),
    );
    expect(html).toContain('$79/yr');
    expect(html).toContain('CAD');
    expect(html).toContain('Full refund anytime');
    expect(html).not.toContain('C$');
    expect(html).not.toContain('ask for a refund');
  });
});

describe('FreeJoinCard', () => {
  it('keeps the free promise next to founding join', () => {
    const html = renderToStaticMarkup(createElement(FreeJoinCard));
    expect(html).toContain('Free');
    expect(html).toContain('Everything Hale does is free for you.');
    expect(html).not.toMatch(/\$\d/);
  });
});

describe('/founding two-option pair', () => {
  it('renders Free and founding annual together, with no monthly or list annual', () => {
    const html = renderToStaticMarkup(
      createElement('div', null, [
        createElement(FreeJoinCard, { key: 'free' }),
        createElement(FoundingJoinForm, {
          key: 'founding',
          priceLabel: '$79/yr',
          currency: 'CAD',
        }),
      ]),
    );
    expect(html).toContain('Free');
    expect(html).toContain('$79/yr');
    expect(html).toContain('Join as a founding family');
    expect(html).not.toContain('/mo');
    expect(html).not.toContain('$159/yr');
    expect(html).not.toContain('Continue ·');
  });
});
