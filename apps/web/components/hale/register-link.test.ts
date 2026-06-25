import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { registerLinkHref } from '~/lib/village/register-link';
import { RegisterLink } from './register-link';

/**
 * Hale owns discovery; the provider owns registration — so a card must ALWAYS
 * offer a way out to register. These assert the fallback (a coarse-area search
 * when there is no source URL) and that the link opens in a new tab safely.
 */

describe('registerLinkHref — always resolves a details/registration URL', () => {
  it('uses the discovered source URL when present', () => {
    expect(registerLinkHref('https://ymca.ca/swim', 'Swim', 'M4K')).toBe('https://ymca.ca/swim');
  });

  it('treats an empty / whitespace source URL as absent', () => {
    expect(registerLinkHref('   ', 'Toddler Swim', 'M4K')).toBe(
      'https://www.google.com/search?q=Toddler%20Swim%20M4K',
    );
  });

  it('falls back to a Google search over the title + coarse area when the URL is null', () => {
    expect(registerLinkHref(null, 'Riverdale Library story time', 'Toronto')).toBe(
      'https://www.google.com/search?q=Riverdale%20Library%20story%20time%20Toronto',
    );
  });

  it('builds a search from the title alone when no area is on file', () => {
    expect(registerLinkHref(null, 'Saturday drop-in', null)).toBe(
      'https://www.google.com/search?q=Saturday%20drop-in',
    );
  });
});

describe('RegisterLink — the prominent secondary, new-tab safe', () => {
  it('renders the bordered secondary treatment, never a buried ghost link', () => {
    const html = renderToStaticMarkup(
      createElement(RegisterLink, { sourceUrl: 'https://ymca.ca/swim', title: 'Swim', area: 'M4K' }),
    );
    expect(html).toContain('btn-secondary');
    expect(html).toContain('view details');
    expect(html).toContain('register');
    expect(html).not.toContain('btn-ghost');
  });

  it('falls back to a venue search and opens in a new tab with rel=noreferrer when the URL is null', () => {
    const html = renderToStaticMarkup(
      createElement(RegisterLink, { sourceUrl: null, title: 'Toddler Swim', area: 'M4K' }),
    );
    expect(html).toContain('href="https://www.google.com/search?q=Toddler%20Swim%20M4K"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });
});
