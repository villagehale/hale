import { expect, test } from '@playwright/test';

/**
 * E2E for the PUBLIC, pre-auth preview funnel (app.villagehale.com/preview).
 *
 * This is the part of the funnel that ships LIVE with no auth: an anonymous
 * visitor picks a coarse age STAGE + a coarse area + optional intent chips, gets
 * a real (LLM-discovered) sample of local activities, and is handed off to
 * sign-in. The privacy contract (CLAUDE.md rule #1) is that NO child-identifying
 * data — no name, no date of birth — is collected or persisted before account +
 * consent. Since F14 deleted the web onboarding wizard, the handoff now carries
 * NOTHING at all: the coarse intake used to be stashed for the wizard to hydrate
 * from, and with no wizard to read it the write is gone too.
 *
 * Runs against PREVIEW_BASE_URL (default https://app.villagehale.com). The
 * discovery step is a real Claude call (~5–10s), so that step waits generously.
 */

const SIGN_IN_HANDOFF = '/sign-in';

test.describe('pre-auth preview funnel (public)', () => {
  test('renders the anonymous intake', async ({ page }) => {
    await page.goto('/preview');

    await expect(
      page.getByRole('heading', { name: 'See what Hale finds for you.' }),
    ).toBeVisible();

    for (const name of ['Newborn under 1', 'Toddler 1 – 3', 'Child 4 – 12', 'Teenager 13 +']) {
      await expect(page.getByRole('button', { name })).toBeVisible();
    }

    await expect(page.getByRole('textbox', { name: 'your area' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Activities & classes' })).toBeVisible();

    const showMe = page.getByRole('button', { name: 'show me' });
    await expect(showMe).toBeVisible();
    await expect(showMe).toBeDisabled();
  });

  test('toddler + area + intent → sample renders and CTA hands off to sign-in', async ({ page }) => {
    await page.goto('/preview');

    await page.getByRole('button', { name: 'Toddler 1 – 3' }).click();
    await page.getByRole('textbox', { name: 'your area' }).fill('Toronto M5V');
    await page.getByRole('button', { name: 'Activities & classes' }).click();

    const showMe = page.getByRole('button', { name: 'show me' });
    await expect(showMe).toBeEnabled();
    await showMe.click();

    await expect(
      page.getByRole('heading', { name: 'Here’s a taste of your village.' }),
    ).toBeVisible({ timeout: 30_000 });

    await expect(page.getByText('a sample of what’s near Toronto M5V')).toBeVisible();
    expect(await page.getByRole('article').count()).toBeGreaterThan(0);

    const cta = page.getByRole('link', { name: 'Save this + set up your family' });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', SIGN_IN_HANDOFF);
  });

  test('teen stage → honest privacy-first message, NOT a sample', async ({ page }) => {
    await page.goto('/preview');

    await page.getByRole('button', { name: 'Teenager 13 +' }).click();
    await page.getByRole('textbox', { name: 'your area' }).fill('Toronto M5V');
    await page.getByRole('button', { name: 'show me' }).click();

    await expect(page.getByText('Hale supports teens too')).toBeVisible();
    await expect(page.getByText('never their messages')).toBeVisible();

    // No discovery sample for teens (rule #1) — no model call, no activity cards.
    await expect(
      page.getByRole('heading', { name: 'Here’s a taste of your village.' }),
    ).toHaveCount(0);
    await expect(page.getByRole('article')).toHaveCount(0);

    await expect(page.getByRole('link', { name: 'Set up your family' })).toHaveAttribute(
      'href',
      SIGN_IN_HANDOFF,
    );
  });
});
