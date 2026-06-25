import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AcceptButton } from './accept-button';

/**
 * The accept button derives its "added" state from SERVER data (initiallyAccepted)
 * so a card the family already accepted reads "added to your week" on load and
 * survives the streamed feed remounting it — its optimistic local state alone
 * would reset on every re-render (VIL-122).
 */
describe('AcceptButton', () => {
  it('renders the idle label when not already accepted', () => {
    const html = renderToStaticMarkup(
      createElement(AcceptButton, { href: '/api/village/c1/accept' }),
    );
    expect(html).toContain('add to my week');
    expect(html).not.toContain('added to your week');
  });

  it('renders the added state (disabled) when initiallyAccepted', () => {
    const html = renderToStaticMarkup(
      createElement(AcceptButton, { href: '/api/village/c1/accept', initiallyAccepted: true }),
    );
    expect(html).toContain('added to your week');
    expect(html).toContain('disabled');
  });
});
