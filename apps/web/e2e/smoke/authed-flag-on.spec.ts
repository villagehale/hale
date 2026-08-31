import path from 'node:path';
import { type Browser, type Page, expect, test } from '@playwright/test';
import { encode } from 'next-auth/jwt';

/**
 * The flag-on authed render walk — the lane that catches the #577 class: a server
 * render crossing the RSC/client boundary with unserializable or broken data is
 * invisible to tsc and vitest, and only a real `next start` render sees it.
 *
 * Three independent trips per page:
 *   1. status + a POSITIVE content marker (a blank 200 can never pass — the
 *      negative-assertion law), where /family's marker is the seeded child's name,
 *      proof the RSC + DB path actually executed;
 *   2. error-boundary text must be ABSENT (authed boundary, admin panel boundary,
 *      Next's prod root-crash fallback);
 *   3. zero page errors / console errors.
 *
 * Sessions are MINTED (the hale-prod-qa trick, http cookie names): no login UI is
 * exercised. `sub` is users.external_auth_id — never users.id.
 */

const SESSION_COOKIE = 'authjs.session-token'; // http ⇒ no __Secure- prefix; salt = cookie name

const ERROR_MARKERS = [
  'we couldn’t load this just now', // app/(authed)/error.tsx
  'didn’t load — check the logs', // components/admin/panel-boundary.tsx
  'Application error: a server-side exception', // Next prod root-crash fallback
];

/** Add an entry ONLY with observed evidence (a logged line the walk must tolerate). */
const CONSOLE_ALLOWLIST: RegExp[] = [];

const SCREEN_DIR = path.resolve(process.cwd(), 'e2e-artifacts/screens');

async function mintSessionCookie(sub: string, email: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is not set'); // config already guards; belt+braces
  const value = await encode({
    secret,
    salt: SESSION_COOKIE,
    maxAge: 3600,
    token: { sub, email },
  });
  return {
    name: SESSION_COOKIE,
    value,
    domain: 'localhost',
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'Lax' as const,
  };
}

type Viewer = 'admin' | 'parent' | 'anonymous';

async function openPage(browser: Browser, viewer: Viewer): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext();
  if (viewer !== 'anonymous') {
    const sub = viewer === 'admin' ? 'smoke-admin' : 'smoke-parent';
    await context.addCookies([await mintSessionCookie(sub, `${sub}@example.test`)]);
  }
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (CONSOLE_ALLOWLIST.some((rx) => rx.test(text))) return;
    errors.push(`console.error: ${text}`);
  });
  return { page, errors };
}

async function assertHealthy(page: Page, errors: string[], shot: string) {
  const body = await page.locator('body').innerText();
  for (const marker of ERROR_MARKERS) {
    expect(body, `error-boundary marker on ${page.url()}`).not.toContain(marker);
  }
  await page.screenshot({ path: path.join(SCREEN_DIR, `${shot}.png`), fullPage: true });
  expect(errors, `page/console errors on ${page.url()}`).toEqual([]);
}

test('sign-in renders the flag-on phone door (no cookie)', async ({ browser }) => {
  const { page, errors } = await openPage(browser, 'anonymous');
  const response = await page.goto('/sign-in');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  // Flag-on subtitle — with the flag off this page shows the email/Google door instead.
  await expect(page.getByText('the number you text me on')).toBeVisible();
  await assertHealthy(page, errors, '01-sign-in');
});

test('/home forwards to /family — the middleware flag hinge (positive control that F14_RECEIPTS_IA is armed)', async ({
  browser,
}) => {
  const { page, errors } = await openPage(browser, 'admin');
  const response = await page.goto('/home');
  expect(response?.status()).toBe(200);
  // The 302 target: if the env were lost, /home would render the daily feed and this fails
  // instead of the walk silently exercising flag-off pages.
  await expect(page).toHaveURL(/\/family$/);
  await assertHealthy(page, errors, '02-home-forward');
});

test('/family renders the seeded family (RSC + DB path executed)', async ({ browser }) => {
  const { page, errors } = await openPage(browser, 'admin');
  const response = await page.goto('/family');
  expect(response?.status()).toBe(200);
  await expect(page.getByText('Juniper')).toBeVisible();
  await assertHealthy(page, errors, '03-family');
});

test('/settings renders the reveal rows — the #577 page', async ({ browser }) => {
  const { page, errors } = await openPage(browser, 'admin');
  const response = await page.goto('/settings');
  expect(response?.status()).toBe(200);
  // The SettingsRowReveal rows: a reintroduced RSC-serialization crash streams the
  // authed error boundary here instead of these controls.
  await expect(page.getByRole('button', { name: 'Change' }).first()).toBeVisible();
  await expect(page.getByText('How you reach Hale')).toBeVisible();
  await assertHealthy(page, errors, '04-settings');
});

test('/approvals renders the flag-on landing surface', async ({ browser }) => {
  const { page, errors } = await openPage(browser, 'admin');
  const response = await page.goto('/approvals');
  expect(response?.status()).toBe(200);
  // Fresh seed ⇒ nothing pending ⇒ the caught-up state is the honest marker.
  await expect(page.getByText('All caught up')).toBeVisible();
  await assertHealthy(page, errors, '05-approvals');
});

test('/trail renders the audit tally', async ({ browser }) => {
  const { page, errors } = await openPage(browser, 'admin');
  const response = await page.goto('/trail');
  expect(response?.status()).toBe(200);
  await expect(page.getByText('actions recorded')).toBeVisible();
  await assertHealthy(page, errors, '06-trail');
});

test('/admin renders the founder panels for the allowlisted phone', async ({ browser }) => {
  const { page, errors } = await openPage(browser, 'admin');
  const response = await page.goto('/admin');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Texting' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Growth' })).toBeVisible();
  // assertHealthy also proves no panel fell into its boundary ("didn’t load — check the logs").
  await assertHealthy(page, errors, '07-admin');
});

test('/admin answers 404 for a signed-in non-admin (the layout notFound arm)', async ({
  browser,
}) => {
  const { page, errors } = await openPage(browser, 'parent');
  const response = await page.goto('/admin');
  // The middleware only covers the session-less probe; this walks the
  // (admin)/admin/layout.tsx notFound() arm for a real session without the phone.
  expect(response?.status()).toBe(404);
  await page.screenshot({ path: path.join(SCREEN_DIR, '08-admin-denied.png'), fullPage: true });
  expect(errors, `page/console errors on ${page.url()}`).toEqual([]);
});

test('/family redirects a cookie-less visitor to /sign-in (auth-gate positive control)', async ({
  browser,
}) => {
  const { page, errors } = await openPage(browser, 'anonymous');
  await page.goto('/family');
  // Proves the 200s above are real auth at work, not a dev-preview fallback
  // leaving the route group unprotected.
  await expect(page).toHaveURL(/\/sign-in/);
  await assertHealthy(page, errors, '09-anonymous-redirect');
});
