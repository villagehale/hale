import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteFooter } from '~/components/site-footer.js';
import { SiteHeader } from '~/components/site-header.js';
import sitemap from '../sitemap.js';
import { metadata } from './page.js';

/**
 * /text ships dark (D21): it is the QR cards' destination, not a public page.
 * Until the number is provisioned and the cards are out, nothing may point at
 * it — no nav link, no sitemap row — and search engines are told to skip it.
 * These are the structural guards; the page's own behaviour lives in
 * components/text-entry.test.ts.
 */

describe('/text (unlisted entry surface)', () => {
  it('is noindex, nofollow', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it('claims its own canonical rather than inheriting the homepage’s', () => {
    expect(metadata.alternates?.canonical).toBe('/text');
  });

  it('is absent from the sitemap', () => {
    for (const entry of sitemap()) {
      expect(entry.url.endsWith('/text')).toBe(false);
    }
  });

  it('is linked from no site navigation', () => {
    const chrome =
      renderToStaticMarkup(createElement(SiteHeader)) +
      renderToStaticMarkup(createElement(SiteFooter));
    expect(chrome).not.toContain('/text');
  });
});
