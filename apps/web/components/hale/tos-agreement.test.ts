import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TosAgreement } from './tos-agreement';

/**
 * The single Terms/Privacy agreement row, shared by the account step (Phase B)
 * and the setup step (Phase C) so the legal line can never drift into two copies.
 * It must carry the checkbox and BOTH policy links.
 */
const html = renderToStaticMarkup(
  createElement(TosAgreement, { checked: false, onChange: () => {} }),
);

describe('TosAgreement', () => {
  it('renders a checkbox linking BOTH the Terms of Service and the Privacy Policy', () => {
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('Terms of Service');
    expect(html).toContain('Privacy Policy');
  });

  it('reflects the checked state', () => {
    const checkedHtml = renderToStaticMarkup(
      createElement(TosAgreement, { checked: true, onChange: () => {} }),
    );
    expect(checkedHtml).toContain('checked');
  });
});
