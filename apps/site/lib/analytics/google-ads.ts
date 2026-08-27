/**
 * Google Ads landing-page measurement for the marketing site (villagehale.com).
 *
 * Public by design — this is the conversion / remarketing id Google's snippet
 * ships in the page source. A second Google product (GA4, another Ads account)
 * adds a `gtag('config', ...)` call to {@link GOOGLE_ADS_BOOTSTRAP}, not a second
 * `gtag.js` loader. The product app (apps/web) must not import this module.
 */

export const GOOGLE_ADS_ID = 'AW-18412881223';

export const GOOGLE_ADS_GTAG_SRC = `https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_ID}`;

export const GOOGLE_ADS_BOOTSTRAP = [
  'window.dataLayer = window.dataLayer || [];',
  'function gtag(){dataLayer.push(arguments);}',
  "gtag('js', new Date());",
  `gtag('config', '${GOOGLE_ADS_ID}');`,
].join('\n');
