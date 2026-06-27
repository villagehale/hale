import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The account step is a client component that transitively imports the two
// server actions (which chain into next-auth — unresolvable under vitest). Stub
// those seams; nothing here is the LLM (rule #8). Rendered to static markup, as
// the other component tests do.
vi.mock('~/lib/onboarding/complete-onboarding', () => ({ completeOnboarding: vi.fn() }));
vi.mock('~/lib/onboarding/sign-in-action', () => ({ startGoogleSignIn: vi.fn() }));

import { AccountStep } from '~/app/onboarding/wizard';

function render(
  props: Partial<Parameters<typeof AccountStep>[0]> & { signedIn: boolean },
): string {
  return renderToStaticMarkup(
    createElement(AccountStep, {
      authReady: true,
      sessionName: null,
      tosAccepted: false,
      onToggleTos: () => {},
      onBack: () => {},
      onContinue: () => {},
      onGoogle: () => {},
      ...props,
    }),
  );
}

/**
 * Phase B ("create your account") must respect `signedIn`. The funnel signs users
 * in BEFORE onboarding (preview → /sign-in → /onboarding), so an email/password
 * parent reaches this step already authenticated; a Google-only step strands them.
 */
describe('OnboardingWizard account step (phase B)', () => {
  it('signed-in: shows a non-Google continue affordance, not "continue with Google"', () => {
    const html = render({ signedIn: true, sessionName: 'Maya Ramos' });
    expect(html).not.toContain('continue with Google');
    expect(html).toContain('continue →');
  });

  it('signed-out: still shows the Google account-creation form', () => {
    const html = render({ signedIn: false });
    expect(html).toContain('continue with Google');
  });
});
