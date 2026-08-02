import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { PrivacyNote } from '~/components/hale/privacy-note';
import nextConfig from '../next.config';
import { PRIVACY_URL, TERMS_URL } from './legal-links';

/**
 * VIL-256 — the policies moved to the marketing site (D20). The app keeps its
 * `/terms` and `/privacy` paths forever, as permanent redirects: emails already
 * sent, consent records already written, and mobile builds already in the App
 * Store all name the app URLs, and none of those can be rewritten after the fact.
 */

describe('policy URLs', () => {
  it('point at www, not the apex (which is itself a redirect) and not the app', () => {
    for (const url of [TERMS_URL, PRIVACY_URL]) {
      expect(url.startsWith('https://www.villagehale.com/')).toBe(true);
      expect(url).not.toContain('app.villagehale.com');
    }
    expect(TERMS_URL).toBe('https://www.villagehale.com/terms');
    expect(PRIVACY_URL).toBe('https://www.villagehale.com/privacy');
  });
});

describe('the app’s legal routes', () => {
  it('forward to the marketing policies permanently (308), both of them', async () => {
    const redirects = await nextConfig.redirects?.();
    expect(redirects).toBeDefined();
    const bySource = new Map((redirects ?? []).map((r) => [r.source, r]));

    expect(bySource.get('/terms')).toMatchObject({
      destination: TERMS_URL,
      permanent: true,
    });
    expect(bySource.get('/privacy')).toMatchObject({
      destination: PRIVACY_URL,
      permanent: true,
    });
  });
});

describe('the app’s own policy links', () => {
  it('send a reader straight to the policy rather than through the redirect', () => {
    const html = renderToStaticMarkup(h(PrivacyNote));
    expect(html).toContain(`href="${PRIVACY_URL}"`);
    expect(html).not.toContain('href="/privacy"');
  });
});
