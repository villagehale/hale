import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Google Ads on the MARKETING site loads only after the visitor taps Accept.
 *
 * The tag is not in the server HTML. A client loader injects gtag.js and sets
 * Consent Mode v2 (default denied, then granted) before config. The product
 * app still does not ship it. The privacy policy names the tag, because it
 * writes advertising cookies once the visitor has agreed.
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

describe('Google Ads tag — marketing site, after consent', () => {
  it('does not put gtag in the server HTML', () => {
    expect(layout).not.toContain('GoogleAdsTag');
    expect(layout).not.toContain('googletagmanager.com/gtag/js');
    expect(layout).toContain('CONSENT_NO_FLASH_SCRIPT');
    expect(layout).toContain('ConsentBanner');
  });

  it('never ships on the product app', () => {
    expect(webLayout).not.toContain(ADS_ID);
    expect(webLayout).not.toContain('GoogleAdsTag');
    expect(webLayout).not.toContain('googletagmanager.com/gtag/js');
  });
});

describe('Google Ads snippet', () => {
  it('loads gtag.js once, with Consent Mode denied then granted, before config', async () => {
    const { GOOGLE_ADS_ID, GOOGLE_ADS_GTAG_SRC } = await import('./google-ads.js');
    const client = readFileSync(fileURLToPath(new URL('./google-ads-client.ts', import.meta.url)), 'utf8');

    expect(GOOGLE_ADS_ID).toBe(ADS_ID);
    expect(GOOGLE_ADS_GTAG_SRC).toBe(`https://www.googletagmanager.com/gtag/js?id=${ADS_ID}`);
    const deniedAt = client.indexOf("gtag('consent', 'default'");
    const grantedAt = client.indexOf("gtag('consent', 'update'");
    const configAt = client.indexOf(`gtag('config', GOOGLE_ADS_ID)`);
    expect(deniedAt).toBeGreaterThan(-1);
    expect(deniedAt).toBeLessThan(grantedAt);
    expect(grantedAt).toBeLessThan(configAt);
    expect(client).toContain('ad_storage: \'denied\'');
    expect(client).toContain('ad_storage: \'granted\'');
    expect([...client.matchAll(/googletagmanager/g)]).toHaveLength(0);
    expect(client).toContain('GOOGLE_ADS_GTAG_SRC');
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
