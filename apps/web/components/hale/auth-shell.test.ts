import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthShell } from './auth-shell';

/**
 * The auth frame is the redesigned split card floating on a full-viewport
 * Prussian-navy stage: a deep-navy brand stage on the left and the form column on
 * the right. These assert the load-bearing decisions — the immersive backdrop, the
 * split card, the navy stage carrying the brand value line, the decorative
 * illustration, that the page's form and heading land in the form column, and that
 * the trust line and theme toggle survive — rather than whatever markup the
 * component happens to emit.
 */

const html = renderToStaticMarkup(
  createElement(
    AuthShell,
    { heading: 'Welcome back', subtitle: 'Sign in to your village.' },
    createElement('form', null, 'FORM_SLOT'),
  ),
);

describe('AuthShell — the split-card auth frame', () => {
  it('renders the immersive navy backdrop and the split card', () => {
    expect(html).toContain('auth-backdrop');
    expect(html).toContain('auth-card');
  });

  it('renders the navy brand stage carrying the brand value line', () => {
    expect(html).toContain('auth-stage');
    expect(html).toContain('every parent needs');
  });

  it('stages the village illustration as decorative (aria-hidden, no alt text)', () => {
    expect(html).toContain('auth-stage-art');
    expect(html).toMatch(/aria-hidden="true"[^>]*alt=""|alt=""[^>]*aria-hidden="true"/);
  });

  it('renders the page heading as the document h1 and the subtitle beneath it', () => {
    expect(html).toMatch(/<h1[^>]*>\s*Welcome back\s*<\/h1>/);
    expect(html).toContain('Sign in to your village.');
  });

  it('places the page-supplied form into the form panel', () => {
    expect(html).toContain('auth-panel');
    expect(html).toContain('FORM_SLOT');
  });

  it('carries a warm data-residency trust line (Canada, nothing shared unasked)', () => {
    expect(html).toContain('stays in Canada');
    expect(html).toContain('Nothing is shared until you say so');
  });

  it('keeps the theme toggle in the frame', () => {
    expect(html).toContain('Color theme');
  });
});
