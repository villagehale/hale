import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SaveButton } from './save-button';

/**
 * The private-save ("I'm interested") bookmark toggle — the web parity for the
 * mobile RecCard/detail-sheet save. It derives its saved state from SERVER data
 * (initiallySaved) so a card the family already saved survives the streamed feed
 * remounting it (mirrors AcceptButton / EndorseButton).
 *
 * A save is PRIVATE and low-commitment: it neither enrolls nor sends for approval
 * (that is Accept), so the copy stays "I'm interested" / "saved", never
 * "sent for your approval".
 */
describe('SaveButton', () => {
  it('renders the interested label and unpressed state when not already saved', () => {
    const html = renderToStaticMarkup(
      createElement(SaveButton, { endpoint: '/api/village/c1/save' }),
    );
    // renderToStaticMarkup HTML-escapes the apostrophe in "I'm interested".
    expect(html).toContain('i&#x27;m interested');
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('sent for your approval');
  });

  it('renders the saved label and pressed state when initiallySaved', () => {
    const html = renderToStaticMarkup(
      createElement(SaveButton, { endpoint: '/api/village/c1/save', initiallySaved: true }),
    );
    expect(html).toContain('saved');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain('sent for your approval');
  });
});
