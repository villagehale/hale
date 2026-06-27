import { expect, test } from '@playwright/test';

/**
 * E2E for the PUBLIC, pre-auth preview funnel (app.villagehale.com/preview).
 *
 * This is the part of the funnel that ships LIVE with no auth: an anonymous
 * visitor picks a coarse age STAGE + a coarse area + optional intent chips, gets
 * a real (LLM-discovered) sample of local activities, and is handed off to
 * sign-in. The privacy contract (CLAUDE.md rule #1) is that NO child-identifying
 * data — no name, no date of birth — is collected or persisted before account +
 * consent; only the three coarse fields cross the sign-in boundary.
 *
 * Runs against PREVIEW_BASE_URL (default https://app.villagehale.com). The
 * discovery step is a real Claude call (~5–10s), so that step waits generously.
 */

const SIGN_IN_HANDOFF = '/sign-in?callbackUrl=/onboarding';

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

  test('rule #1: handoff draft carries ONLY coarse fields — no name, no DOB', async ({ page }) => {
    await page.goto('/preview');

    await page.getByRole('button', { name: 'Toddler 1 – 3' }).click();
    await page.getByRole('textbox', { name: 'your area' }).fill('Toronto M5V');
    await page.getByRole('button', { name: 'Activities & classes' }).click();
    await page.getByRole('button', { name: 'show me' }).click();

    const cta = page.getByRole('link', { name: 'Save this + set up your family' });
    await expect(cta).toBeVisible({ timeout: 30_000 });

    // Clicking the CTA is what writes the draft (saveAndSetUp) and navigates to
    // sign-in; sessionStorage survives the same-origin navigation, so we read it
    // on the sign-in page. The sample is long, so bring the CTA into view first.
    await cta.scrollIntoViewIfNeeded();
    await cta.click();
    await expect(page).toHaveURL(/\/sign-in\?callbackUrl=\/onboarding$/);

    const raw = await page.evaluate(() => window.sessionStorage.getItem('hale_intake'));
    expect(raw).not.toBeNull();
    const draft = JSON.parse(raw as string) as Record<string, unknown>;

    // Exactly the coarse intake: stage / area / intents (+ plan + tos), nothing more.
    expect(draft).toEqual({
      childNames: [],
      city: 'Toronto M5V',
      intents: ['activities'],
      planTier: 'free',
      tosAccepted: false,
      stage: 'toddler',
    });

    // The privacy invariant, asserted explicitly so it fails loudly if the draft
    // ever grows a sensitive field: no name, no date of birth, no precise address.
    expect(draft.childNames).toEqual([]);
    expect(draft).not.toHaveProperty('childName');
    expect(draft).not.toHaveProperty('name');
    expect(draft).not.toHaveProperty('dob');
    expect(draft).not.toHaveProperty('dateOfBirth');
    expect(draft).not.toHaveProperty('birthDate');
    expect(draft).not.toHaveProperty('address');
    expect(draft).not.toHaveProperty('postalCode');
  });

  /**
   * SKIPPED — needs an authenticated session this public-funnel run can't mint.
   *
   * After sign-in with the draft above present, onboarding (Phase A/C) hydrates
   * from the same `hale_intake` sessionStorage key (apps/web/app/onboarding/
   * wizard.tsx → readIntakeDraft): it pre-fills the coarse city + intents and
   * carries the stage as a non-binding HINT, while the exact DOB and full
   * address are still entered and consented post-auth in Phase C (rule #1).
   *
   * The assertion I WOULD make once a session exists:
   *   await page.goto('/onboarding');
   *   await expect(page.getByLabel('your city')).toHaveValue('Toronto M5V');
   *   await expect(page.getByRole('button', { name: 'Activities & classes' }))
   *     .toHaveAttribute('aria-pressed', 'true');
   *   await expect(page.getByText('from your preview')).toBeVisible(); // stage hint
   *   // and NO DOB pre-filled — the date-of-birth field stays empty pre-consent.
   */
  test.skip('post-sign-in onboarding pre-fills area + stage hint (needs auth)', async () => {});
});
