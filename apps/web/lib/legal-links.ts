/**
 * Where Hale's policies live. D20 (F14 Surfaces Plan) moved Terms and Privacy off
 * the app domain onto the marketing site; the app's own `/terms` and `/privacy`
 * are permanent 308s to these (see `next.config.ts`), kept FOREVER because sent
 * emails, stored consent records and shipped mobile builds still carry the old
 * app URLs.
 *
 * `www`, not the apex: `villagehale.com` itself 308-redirects to `www`, so linking
 * the apex would cost every reader a second hop. Matches apps/site's `SITE_URL`.
 */
export const MARKETING_SITE_URL = 'https://www.villagehale.com';

export const TERMS_URL = `${MARKETING_SITE_URL}/terms`;
export const PRIVACY_URL = `${MARKETING_SITE_URL}/privacy`;
