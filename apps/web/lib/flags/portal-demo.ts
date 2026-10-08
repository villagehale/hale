/**
 * Seeded portal for design QA. On for local `next start` and Vercel Preview.
 * Off only when Vercel marks the deployment production, so Production never
 * serves `/demo` and the gate is not a flag anyone has to set.
 *
 * `VERCEL_ENV` is `preview` or `production` on Vercel and unset locally.
 * `NODE_ENV` is `production` for both Preview and `next start`, so it cannot
 * tell them apart.
 *
 * Preview env that turns the REAL door on (set on the Vercel Preview
 * environment only — never Production). The demo route does not read these.
 *
 * - `F14_RECEIPTS_IA` = `true` with no trailing newline (`printf '%s' true`).
 *   That is the phone door and the portal shell. Anything else, including
 *   `true\n`, stays off.
 * - `AUTH_SECRET` = a Preview-only random string (`openssl rand -base64 33`).
 *   Auth.js uses it to sign the session JWT. Without it, Preview (NODE_ENV
 *   production) fail-closes every authed route to `/sign-in`.
 * - `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` — only for the
 *   flag-off Google button. The flag-on door hides that button.
 *
 * Completing a phone sign-in also needs the existing server secrets
 * (`DATABASE_URL`, `APP_ENCRYPTION_KEY`, `LINQ_API_KEY`, `LINQ_FROM_E164`).
 * Do not point Preview `DATABASE_URL` at production. `/demo/portal` is the
 * path that needs none of them.
 */
export function portalDemoEnabled(): boolean {
  return process.env.VERCEL_ENV !== 'production';
}
