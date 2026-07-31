import { expect, test } from '@playwright/test';

/**
 * VIL-245 · M10 — E2E for the PUBLIC, account-less RSVP page (/rsvp/:token).
 *
 * This is the one Hale surface built for people who are not customers, so the spec is
 * written from a stranger's side of it: an anonymous visitor with a link, no session,
 * and no intention of making one.
 *
 * Runs against PREVIEW_BASE_URL (default https://app.villagehale.com).
 *
 * TWO SUITES, and the split is about what a link can be verified without one:
 *
 *   `dead link` needs no data at all — an unknown token must render the same friendly
 *     not-found state as a revoked one, at both widths, with no horizontal scroll. It
 *     is runnable anywhere, including a local `next dev` with no DATABASE_URL (which is
 *     exactly the null branch the loader takes), and it is the one that catches a
 *     layout regression on the page a mistyped link lands on.
 *   `live invite` needs a real party, so it is gated on RSVP_E2E_TOKEN and SKIPS
 *     cleanly without it. Set it to a minted `party_invites.public_token` after the
 *     migration lands:
 *       RSVP_E2E_TOKEN=<token> pnpm --filter @hale/web test:e2e rsvp-public
 *     A silent pass would be worse than a skip, so the skip is explicit.
 */

const NARROW = { width: 320, height: 720 };
const WIDE = { width: 1440, height: 900 };

/** No page in Hale may scroll sideways — least of all one opened on a phone from a
 * group chat. Measured on the document, which is where the overflow would land. */
async function assertNoHorizontalScroll(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('public RSVP page — dead link', () => {
  for (const [label, size] of [
    ['320 (phone)', NARROW],
    ['1440 (desktop)', WIDE],
  ] as const) {
    test(`renders the not-found state at ${label} without sideways scroll`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto('/rsvp/this-token-does-not-exist');

      await expect(
        page.getByRole('heading', { name: "this invite isn't here anymore." }),
      ).toBeVisible();
      await assertNoHorizontalScroll(page);
    });
  }

  test('is never indexable — a family address does not belong in a search result', async ({
    page,
  }) => {
    const response = await page.goto('/rsvp/this-token-does-not-exist');
    expect(response?.status()).toBe(200);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      /noindex/,
    );
  });

  test('leaks nothing about whether the token ever existed', async ({ page }) => {
    // An unknown token and a deleted one must be indistinguishable, or the token space
    // becomes probeable.
    await page.goto('/rsvp/aaaaaaaaaaaaaaaaaaaaaaaa');
    const first = await page.locator('main').innerText();
    await page.goto('/rsvp/bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(await page.locator('main').innerText()).toBe(first);
  });
});

const token = process.env.RSVP_E2E_TOKEN;

test.describe('public RSVP page — live invite', () => {
  test.skip(!token, 'set RSVP_E2E_TOKEN to a minted party_invites.public_token');

  test('an anonymous visitor can RSVP end-to-end with no account', async ({ page }) => {
    await page.setViewportSize(NARROW);
    await page.goto(`/rsvp/${token}`);

    await expect(page.getByText("you're invited")).toBeVisible();
    await assertNoHorizontalScroll(page);

    // Nothing on the invite asks for an account, and nothing offers one: the soft line
    // is confirmation-only.
    const before = await page.locator('main').innerText();
    expect(before.toLowerCase()).not.toContain('sign in');
    expect(before.toLowerCase()).not.toContain('sign up');

    await page.getByRole('button', { name: "I'll be there" }).click();
    await page.getByLabel('your name').fill('Playwright Guest');
    await page.getByLabel('how many of you').fill('2');

    // The reminder box is UNCHECKED by default — no phone field until it is ticked.
    await expect(page.getByLabel(/Text me a reminder/)).not.toBeChecked();
    await expect(page.getByLabel('mobile number')).toHaveCount(0);

    await page.getByRole('button', { name: 'send my RSVP' }).click();

    await expect(page.getByRole('heading', { name: "You're on the list." })).toBeVisible();
    // No reminder was asked for, so nothing about one is promised.
    await expect(page.getByText(/I'll text you once/)).toHaveCount(0);
    await assertNoHorizontalScroll(page);
  });

  test('the one soft line appears on the confirmation and nowhere before it', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await page.goto(`/rsvp/${token}`);

    const softLine = page.getByText('Hale made this invite for the host.');
    await expect(softLine).toHaveCount(0);

    await page.getByRole('button', { name: "Can't make it" }).click();
    await page.getByLabel('your name').fill('Playwright Decliner');
    await page.getByRole('button', { name: 'send my RSVP' }).click();

    await expect(page.getByRole('heading', { name: 'Thanks for letting them know.' })).toBeVisible();
    await expect(softLine).toBeVisible();
    // Exactly one. The whole marketing budget.
    expect(await softLine.count()).toBe(1);
    await assertNoHorizontalScroll(page);
  });

  test('never shows a guest who else is coming', async ({ page }) => {
    await page.goto(`/rsvp/${token}`);
    const body = (await page.locator('main').innerText()).toLowerCase();
    for (const forbidden of ['coming (', 'rsvps', 'guest list', 'headcount']) {
      expect(body).not.toContain(forbidden);
    }
  });
});
