import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The wizard transitively imports the two server actions (which chain into
// next-auth — unresolvable under vitest) plus next/navigation + the analytics
// hook. Stub those seams; nothing here is the LLM (rule #8). Rendered to static
// markup like the other component tests, so effects (draft hydration, focus) don't
// run — this is exactly the first paint each cohort lands on.
vi.mock('~/lib/onboarding/complete-onboarding', () => ({ completeOnboarding: vi.fn() }));
vi.mock('~/lib/onboarding/sign-in-action', () => ({ startGoogleSignIn: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('~/lib/analytics/posthog-provider', () => ({ useAnalytics: () => vi.fn() }));

import { OnboardingWizard } from '~/app/onboarding/wizard';

function render(
  props: Partial<Parameters<typeof OnboardingWizard>[0]> & { signedIn: boolean },
): string {
  return renderToStaticMarkup(
    createElement(OnboardingWizard, {
      authReady: true,
      google: true,
      magicLink: true,
      sessionName: null,
      ...props,
    }),
  );
}

const wizardSource = readFileSync(
  fileURLToPath(new URL('../../app/onboarding/wizard.tsx', import.meta.url)),
  'utf8',
);

/**
 * The 9-step onboarding flow, split by the auth boundary (rule #1): a signed-out
 * visitor starts at step 1 (pre-auth); a signed-in one with no family resumes at
 * step 7 (post-auth), where the sensitive detail — a child's birthday — is
 * collected for the first time. The segmented progress bar always spans nine.
 */
describe('OnboardingWizard — the 9-step flow', () => {
  it('a signed-out visitor starts at step 1 (welcome), on a 9-segment bar', () => {
    const html = render({ signedIn: false });
    expect(html).toContain('Step 1 of 9');
    // Nine progress segments render (one per step).
    expect((html.match(/class="ob-seg/g) ?? []).length).toBe(9);
    expect(html).toContain('Hale.');
    expect(html).toContain('begin');
    // No sensitive DOB input on the pre-auth welcome step (rule #1).
    expect(html).not.toContain('type="date"');
  });

  it('a signed-in visitor (no family) resumes at step 7, where the birthday is collected', () => {
    const html = render({ signedIn: true });
    expect(html).toContain('Step 7 of 9');
    // Step 7 is the first place a DOB is asked — behind the account wall (rule #1).
    expect(html).toContain('type="date"');
    expect(html).toContain('birthday');
    expect(html).toContain('Get everything ready');
    // The auth step's Google button is step 6, not here.
    expect(html).not.toContain('Continue with Google');
    // The submit is gated until each child has a name + valid birthday — never a
    // silent dead-end.
    expect(html).toContain('name and birthday to continue');
  });
});

/**
 * Source guards for the locked auth decision + rule #1 (things a static first
 * paint can't reach because they live behind a click): step 6 offers Google + a
 * magic link and nothing else, and only non-sensitive intake reaches the pre-auth
 * browser draft.
 */
describe('OnboardingWizard — auth + privacy guards', () => {
  it('the auth step offers Google + magic-link only — no password, no Apple', () => {
    expect(wizardSource).toContain('Continue with Google');
    expect(wizardSource).toContain('MagicLinkRequestForm');
    expect(wizardSource).not.toContain('type="password"');
    // No Apple provider / button (the doc comment naming the decision is fine).
    expect(wizardSource).not.toContain("'apple'");
    expect(wizardSource).not.toMatch(/with apple/i);
  });

  it('the pre-auth draft persists only names / area / intents — never a date of birth', () => {
    // persistDraft builds the IntakeDraft from names + area + intents; the DOB
    // lives in React state and reaches the server just once, at the post-auth
    // completeOnboarding — never sessionStorage (rule #1).
    expect(wizardSource).toContain('childNames: children.map((c) => c.name)');
    expect(wizardSource).not.toMatch(/writeIntakeDraft[\s\S]{0,300}dateOfBirth/);
  });
});
