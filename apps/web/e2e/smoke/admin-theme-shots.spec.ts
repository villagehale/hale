import path from 'node:path';
import { type Browser, type Page, expect, test } from '@playwright/test';
import { encode } from 'next-auth/jwt';

/**
 * Both-theme captures of the admin board — the lane the "light board in a
 * dark shell" defect lived in. The theme is the `.dark` class on <html>
 * (the app's ONLY strategy), decided pre-paint from localStorage
 * `hale-theme`, so each trip seeds the preference via addInitScript before
 * any document loads. Beyond the eyeball artifacts, two machine checks:
 * the board's resolved background must sit on the right side of the
 * lightness ladder per theme, and the agents page must never render a
 * clipped "000ms" latency tick again.
 */

const SESSION_COOKIE = 'authjs.session-token'; // http ⇒ no __Secure- prefix; salt = cookie name
const SCREEN_DIR = path.resolve(process.cwd(), 'e2e-artifacts/screens');

async function mintSessionCookie(sub: string, email: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is not set');
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

async function openThemedAdminPage(browser: Browser, theme: 'light' | 'dark'): Promise<Page> {
  // Tall viewport: the artifacts must show the panels themselves, not an
  // above-the-fold sliver of an inner-scrolled stage.
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 2400 },
  });
  await context.addCookies([await mintSessionCookie('smoke-admin', 'smoke-admin@example.test')]);
  await context.addInitScript((preference) => {
    window.localStorage.setItem('hale-theme', preference);
  }, theme);
  return context.newPage();
}

/** WCAG relative luminance of a computed `rgb(r, g, b)` string. */
function luminanceOf(rgb: string): number {
  const parts = rgb.match(/\d+/g)?.map(Number) ?? [];
  const [r, g, b] = parts;
  if (r === undefined || g === undefined || b === undefined) {
    throw new Error(`unparseable computed color: ${rgb}`);
  }
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Panels arrive via the Reveal entry animation (motion.div from opacity 0);
 * motion's useReducedMotion resolves a beat after hydration, so an immediate
 * screenshot can catch panels transparent. Wait until every grid cell is
 * actually opaque — pages without a grid (Overview) have nothing to settle.
 */
async function settlePanels(page: Page): Promise<void> {
  if ((await page.locator('.adm-grid > *').count()) === 0) return;
  await page.waitForFunction(() => {
    const cells = document.querySelectorAll('.adm-grid > *');
    return (
      cells.length > 0 &&
      [...cells].every((cell) => Number(getComputedStyle(cell).opacity) > 0.99)
    );
  });
}

const PAGES = [
  { route: '/admin', shot: 'overview' },
  { route: '/admin/agents', shot: 'agents' },
  { route: '/admin/operations', shot: 'operations' },
  { route: '/admin/engagement', shot: 'engagement' },
] as const;

for (const theme of ['light', 'dark'] as const) {
  for (const { route, shot } of PAGES) {
    test(`${route} in ${theme}: board rides the ${theme} ladder`, async ({ browser }) => {
      const page = await openThemedAdminPage(browser, theme);
      const response = await page.goto(route);
      expect(response?.status()).toBe(200);
      await settlePanels(page);

      // The pre-paint script honored the seeded preference.
      const hasDarkClass = await page.evaluate(() =>
        document.documentElement.classList.contains('dark'),
      );
      expect(hasDarkClass).toBe(theme === 'dark');

      // THE defect check: the board surface itself, not just the shell.
      const boardBg = await page
        .locator("[data-surface='admin']")
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      const lum = luminanceOf(boardBg);
      if (theme === 'dark') {
        expect(lum, `dark board floats light: ${boardBg}`).toBeLessThan(0.05);
      } else {
        expect(lum, `light board went dark: ${boardBg}`).toBeGreaterThan(0.8);
      }

      await page.screenshot({
        path: path.join(SCREEN_DIR, `theme-${shot}-${theme}.png`),
        fullPage: true,
      });
    });
  }

  test(`/admin/agents in ${theme}: latency ticks are never clipped to "000ms"`, async ({
    browser,
  }) => {
    const page = await openThemedAdminPage(browser, theme);
    await page.goto('/admin/agents');
    // Recharts mounts client-side; the ms axis exists even on a no-run seed
    // (the stated empty-window axis), so waiting for an ms tick specifically
    // is deterministic — a date tick from a sibling chart is not enough.
    await expect(
      page.locator('.recharts-cartesian-axis-tick-value', { hasText: /ms$/ }).first(),
    ).toBeVisible();
    // textContent, not innerText: these are SVG <text> nodes, which have no
    // innerText — allInnerTexts() yields undefined for them.
    const ticks = await page
      .locator('.recharts-cartesian-axis-tick-value')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''));
    const msTicks = ticks.filter((t) => t.endsWith('ms') || t.endsWith('s'));
    // A real axis, not a lone survivor: the no-run seed exercises the stated
    // empty-window axis (fleetAxis), which must produce a full run of ticks.
    expect(
      new Set(msTicks).size,
      `no real latency axis rendered: ${ticks.join(', ')}`,
    ).toBeGreaterThanOrEqual(3);
    for (const tick of msTicks) {
      // A leading-zero multi-digit label is the clipped-gutter signature.
      expect(tick, 'clipped latency tick').not.toMatch(/^0\d/);
    }
  });
}
