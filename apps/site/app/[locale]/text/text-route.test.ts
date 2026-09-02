import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SiteFooter } from '~/components/site-footer.js';
import { SiteHeader } from '~/components/site-header.js';
import sitemap from '../../sitemap.js';
import { generateMetadata } from './page.js';

const meta = () => generateMetadata({ params: Promise.resolve({ locale: 'en' as const }) });

/**
 * /text is the chooser (F14): the QR cards' destination AND the header pill's —
 * but still a handoff, not a page to rank. No sitemap row, noindex, and no
 * footer link; while the number is dark nothing points at it at all. These are
 * the structural guards; the page's own behaviour lives in
 * components/text-entry.test.ts.
 */

describe('/text (unlisted entry surface)', () => {
  it('is noindex, nofollow', async () => {
    expect((await meta()).robots).toEqual({ index: false, follow: false });
  });

  it('claims its own canonical rather than inheriting the homepage’s', async () => {
    expect((await meta()).alternates?.canonical).toBe('/text');
  });

  it('is absent from the sitemap', () => {
    for (const entry of sitemap()) {
      expect(entry.url.endsWith('/text')).toBe(false);
    }
  });

  it('is the header pill’s destination — and stays out of the footer', () => {
    // F14 chooser: the chrome's one primary CTA opens this page (it is the
    // universal target that works on every device). The pill only exists while
    // the number is live; dark, the chrome degrades to email and nothing may
    // point here. The footer never links it — it is a handoff, not navigation.
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');
    const header = renderToStaticMarkup(createElement(SiteHeader));
    expect(header).toContain('href="/text"');
    vi.unstubAllEnvs();
    const darkHeader = renderToStaticMarkup(createElement(SiteHeader));
    expect(darkHeader).not.toContain('/text');
    expect(renderToStaticMarkup(createElement(SiteFooter))).not.toContain('/text');
  });
});
