import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

/**
 * Google Ads landing-page measurement on the MARKETING site.
 *
 * The conversion id has to appear in the server-rendered document head — view-source
 * of a city rec/swim page is how Ads confirms the tag is present. A client-only
 * afterInteractive inject would measure, but would not be in the page source.
 *
 * The pairing this file gates:
 *   · the site-wide layout mounts the tag in `<head>`
 *   · the snippet loads gtag.js once and configs AW-18412881223
 *   · the product app does not ship it
 *   · the privacy policy names the tag, because it writes advertising cookies
 *     (the PostHog posture in posthog-config.test.ts stays memory-only)
 */

const ADS_ID = 'AW-18412881223';

const layout = readFileSync(
  fileURLToPath(new URL('../../app/[locale]/layout.tsx', import.meta.url)),
  'utf8',
);

const privacy = readFileSync(
  fileURLToPath(new URL('../../app/[locale]/privacy/page.tsx', import.meta.url)),
  'utf8',
);

const webLayout = readFileSync(
  fileURLToPath(new URL('../../../web/app/layout.tsx', import.meta.url)),
  'utf8',
);

describe('Google Ads tag — marketing site, document head', () => {
  it('mounts the tag inside the site-wide layout <head>, so every public page gets it', () => {
    const head = layout.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? '';
    expect(head).toContain('<GoogleAdsTag');
    // Body is the PostHog / Speed Insights half of analytics; the Ads tag is a
    // document-head script, not a client provider.
    expect(layout).not.toMatch(/<body>[\s\S]*<GoogleAdsTag/);
  });

  it('never ships on the product app', () => {
    expect(webLayout).not.toContain(ADS_ID);
    expect(webLayout).not.toContain('GoogleAdsTag');
    expect(webLayout).not.toContain('googletagmanager.com/gtag/js');
  });
});

describe('Google Ads snippet', () => {
  it('loads gtag.js once and configs the Ads id — a second product would add a config, not a second loader', async () => {
    const { GOOGLE_ADS_ID, GOOGLE_ADS_GTAG_SRC, GOOGLE_ADS_BOOTSTRAP } = await import(
      './google-ads.js'
    );
    const { GoogleAdsTag } = await import('./google-ads-tag.js');

    expect(GOOGLE_ADS_ID).toBe(ADS_ID);
    expect(GOOGLE_ADS_GTAG_SRC).toBe(`https://www.googletagmanager.com/gtag/js?id=${ADS_ID}`);
    expect(GOOGLE_ADS_BOOTSTRAP).toContain(`gtag('config', '${ADS_ID}')`);
    expect(GOOGLE_ADS_BOOTSTRAP).not.toContain('googletagmanager.com');

    const html = renderToStaticMarkup(createElement(GoogleAdsTag));
    expect(html).toContain(ADS_ID);
    expect(html).toContain(GOOGLE_ADS_GTAG_SRC);
    expect([...html.matchAll(/googletagmanager\.com\/gtag\/js/g)]).toHaveLength(1);
    expect(html).toContain(`gtag('config', '${ADS_ID}')`);
  });
});

describe('the privacy policy still matches that posture', () => {
  it('names Google Ads as a marketing-site measurement tag that may set cookies', () => {
    expect(privacy).toContain('<strong>Google Ads</strong>');
    expect(privacy).toContain(ADS_ID);
    expect(privacy).toMatch(/advertising cookies/i);
    expect(privacy).toContain('villagehale.com');
    expect(privacy).not.toMatch(/app\.villagehale\.com[\s\S]{0,80}Google Ads/i);
  });
});
