import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The wizard transitively imports the two server actions (which chain into
// next-auth, unresolvable under vitest) plus next/navigation + analytics hooks.
// Stub those seams; nothing here is the LLM (rule #8). Rendered to static markup
// like the other component tests, so effects don't run — this is exactly the
// first paint an email-cohort parent lands on at Phase C.
vi.mock('~/lib/onboarding/complete-onboarding', () => ({ completeOnboarding: vi.fn() }));
vi.mock('~/lib/onboarding/sign-in-action', () => ({ startGoogleSignIn: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('~/lib/analytics/posthog-provider', () => ({ useAnalytics: () => vi.fn() }));

import { OnboardingWizard } from '~/app/onboarding/wizard';

function renderPhaseC(): string {
  return renderToStaticMarkup(
    createElement(OnboardingWizard, {
      authReady: true,
      signedIn: true,
      startAtSetup: true,
      sessionName: 'Maya Ramos',
    }),
  );
}

/**
 * The email cohort signs in and lands directly at Phase C (?step=setup), skipping
 * Phase B where the ToS checkbox used to be the ONLY agreement affordance. With no
 * draft, tosAccepted starts false — so Phase C must itself carry the same
 * Terms/Privacy row and must explain why "finish" is disabled, or the entire email
 * cohort is stranded on a dead-ended, unexplained disabled button.
 */
describe('OnboardingWizard — Phase C ToS gate (email cohort)', () => {
  const html = renderPhaseC();

  it('renders the Terms/Privacy agreement row when ToS is not yet accepted', () => {
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('Terms of Service');
    expect(html).toContain('Privacy Policy');
  });

  it('disables finish and gives a plain reason (not a bare disabled button)', () => {
    expect(html).toContain('disabled');
    // The reason names the terms as the thing to agree to — human copy, no code.
    expect(html.toLowerCase()).toContain('agree');
    expect(html).not.toContain('tos_required');
  });
});
