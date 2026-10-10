import path from 'node:path';
import { type Browser, type Page, expect, test } from '@playwright/test';
import { encode } from 'next-auth/jwt';

/**
 * The authed render walk — the lane that catches the #577 class: a server
 * render crossing the RSC/client boundary with unserializable or broken data is
 * invisible to tsc and vitest, and only a real `next start` render sees it.
 *
 * Three independent trips per page:
 *   1. status + a POSITIVE content marker (a blank 200 can never pass — the
 *      negative-assertion law), where /family's marker is the seeded child's name,
 *      proof the RSC + DB path actually executed;
 *   2. error-boundary text must be ABSENT (authed boundary, Next's prod
 *      root-crash fallback);
 *   3. zero page errors / console errors.
 *
 * Sessions are MINTED (the hale-prod-qa trick, http cookie names): no login UI is
 * exercised. `sub` is users.external_auth_id — never users.id.
 */

const SESSION_COOKIE = 'authjs.session-token'; // http ⇒ no __Secure- prefix; salt = cookie name

const ERROR_MARKERS = [
  'we couldn’t load this just now', // app/(authed)/error.tsx
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

type Viewer = 'member' | 'anonymous';

async function openPage(
  browser: Browser,
  viewer: Viewer,
): Promise<{ page: Page; errors: string[] }> {
  // reducedMotion: the app's `.rise` entry animation starts at opacity 0 (delays to
  // 760ms), so an un-reduced screenshot catches blank cards; the reduce arm in
  // globals.css renders everything settled — deterministic, eyeball-able artifacts.
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  if (viewer === 'member') {
    await context.addCookies([await mintSessionCookie('smoke-admin', 'smoke-admin@example.test')]);
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

test('sign-in renders the phone door (no cookie)', async ({ browser }) => {
  const { page, errors } = await openPage(browser, 'anonymous');
  const response = await page.goto('/sign-in');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByText('Use the number you text Hale from')).toBeVisible();
  await assertHealthy(page, errors, '01-sign-in');
});

test('/home is the portal landing', async ({ browser }) => {
  const { page, errors } = await openPage(browser, 'member');
  const response = await page.goto('/home');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByText('Waiting on you')).toBeVisible();
  await assertHealthy(page, errors, '02-home');
});

test('/family renders the seeded family (RSC + DB path executed)', async ({ browser }) => {
  const { page, errors } = await openPage(browser, 'member');
  const response = await page.goto('/family');
  expect(response?.status()).toBe(200);
  await expect(page.getByText('Juniper').first()).toBeVisible();
  await assertHealthy(page, errors, '03-family');
});

test('/settings renders the reveal rows — the #577 page', async ({ browser }) => {
  const { page, errors } = await openPage(browser, 'member');
  const response = await page.goto('/settings');
  expect(response?.status()).toBe(200);
  // A reintroduced RSC-serialization crash streams the authed error boundary
  // here instead of these controls.
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByText('Texts from Hale')).toBeVisible();
  await expect(page.getByRole('link', { name: /Connections/ })).toBeVisible();
  await assertHealthy(page, errors, '04-settings');
});

test('/approvals renders the queue', async ({ browser }) => {
  const { page, errors } = await openPage(browser, 'member');
  const response = await page.goto('/approvals');
  expect(response?.status()).toBe(200);
  // Fresh seed ⇒ nothing pending ⇒ the caught-up state is the honest marker.
  await expect(page.getByText('All caught up')).toBeVisible();
  await assertHealthy(page, errors, '05-approvals');
});

test('/trail renders the audit tally', async ({ browser }) => {
  const { page, errors } = await openPage(browser, 'member');
  const response = await page.goto('/trail');
  expect(response?.status()).toBe(200);
  await expect(page.getByText('actions recorded')).toBeVisible();
  await assertHealthy(page, errors, '06-trail');
});

test('/admin is gone: a plain portal 404, and the address does not move', async ({ browser }) => {
  const paths = ['/admin', '/admin/anything', '/admin/ledger/extra'];
  for (const viewer of ['anonymous', 'member'] as const) {
    for (const path of paths) {
      const { page, errors } = await openPage(browser, viewer);
      const response = await page.goto(path);
      expect(response?.status(), `${viewer} ${path}`).toBe(404);
      await expect(page, `${viewer} ${path}`).toHaveURL(new RegExp(`${path}$`));
      await expect(page, `${viewer} ${path}`).toHaveTitle('Page not found · Hale');
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
      // A 404 document logs one resource console error in Chromium.
      const unexpected = errors.filter(
        (line) => !/Failed to load resource: the server responded with a status of 404/.test(line),
      );
      expect(unexpected, `page/console errors on ${page.url()}`).toEqual([]);
      await page.context().close();
    }
  }
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
