import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthShell } from './auth-shell';

/**
 * The auth frame is the two-panel split the redesign introduced: a Spruce brand
 * panel on the left and the form column on the right. These assert the
 * load-bearing layout decisions — the split, the Spruce field, the brand value
 * line, the mobile collapse, and that the page's form is rendered into the
 * column — rather than whatever markup the component happens to emit.
 */

const html = renderToStaticMarkup(
  createElement(AuthShell, { heading: 'Welcome back' }, createElement('form', null, 'FORM_SLOT')),
);

describe('AuthShell — the two-panel auth frame', () => {
  it('lays out as a two-column split on lg+', () => {
    expect(html).toContain('lg:grid-cols-2');
  });

  it('renders the Spruce brand panel that carries the brand value line', () => {
    expect(html).toContain('bg-spruce');
    expect(html).toContain('text-on-spruce');
    expect(html).toContain('every parent needs');
  });

  it('collapses the brand panel below lg so a phone shows only the form', () => {
    expect(html).toMatch(/hidden lg:flex[^"]*/);
  });

  it('places the heading and the page-supplied form into the column', () => {
    expect(html).toContain('Welcome back');
    expect(html).toContain('FORM_SLOT');
  });

  it('carries a warm data-residency trust line (Canada, nothing shared unasked)', () => {
    expect(html).toContain('stays in Canada');
    expect(html).toContain('Nothing is shared until you say so');
  });
});
