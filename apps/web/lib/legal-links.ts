/**
 * Where Hale's policies live. D20 (F14 Surfaces Plan) moved Terms and Privacy off
 * the app domain onto the marketing site; the app's own `/terms` is a permanent 308
 * to its policy (see `next.config.ts`), kept FOREVER because sent emails, stored
 * consent records and shipped mobile builds still carry the old app URL. The app's
 * `/privacy` is the signed-in data-rights page (VIL-432), which links PRIVACY_URL.
 *
 * `www`, not the apex: `villagehale.com` itself 308-redirects to `www`, so linking
 * the apex would cost every reader a second hop. Matches apps/site's `SITE_URL`.
 */
export const MARKETING_SITE_URL = 'https://www.villagehale.com';

export const TERMS_URL = `${MARKETING_SITE_URL}/terms`;
export const PRIVACY_URL = `${MARKETING_SITE_URL}/privacy`;
