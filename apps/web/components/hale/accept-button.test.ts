import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AcceptButton } from './accept-button';

/**
 * The accept button derives its accepted state from SERVER data (initiallyAccepted)
 * so a card the family already accepted survives the streamed feed remounting it —
 * its optimistic local state alone would reset on every re-render (VIL-122).
 *
 * Accepting does NOT add the activity to the week — it drafts an action the parent
 * must approve (rule #4). So the honest accepted copy is "sent for your approval"
 * with a link to /approvals, never "added to your week".
 */
describe('AcceptButton', () => {
  it('renders the idle label when not already accepted', () => {
    const html = renderToStaticMarkup(
      createElement(AcceptButton, { href: '/api/village/c1/accept' }),
    );
    expect(html).toContain('add to my week');
    expect(html).not.toContain('sent for your approval');
    expect(html).not.toContain('added to your week');
  });

  it('renders the sent-for-approval state linking to /approvals when initiallyAccepted', () => {
    const html = renderToStaticMarkup(
      createElement(AcceptButton, { href: '/api/village/c1/accept', initiallyAccepted: true }),
    );
    expect(html).toContain('sent for your approval');
    expect(html).toContain('href="/approvals"');
    expect(html).not.toContain('added to your week');
  });
});
