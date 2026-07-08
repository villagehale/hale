import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
import { ConsentStep } from '~/components/hale/consent-step';

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

const wizardSource = readFileSync(
  fileURLToPath(new URL('../../app/onboarding/wizard.tsx', import.meta.url)),
  'utf8',
);

/**
 * The email cohort signs in and lands directly at Phase C (?step=setup), skipping
 * Phase B. Consent is no longer an inline checkbox on the setup form — it is the
 * dedicated "you're in control" step the setup form leads INTO (consent before
 * provisioning, elevated from a checkbox row). So the setup form must offer a
 * non-dead-ended way forward, the wizard must actually render the ConsentStep that
 * carries the agreement, and the ConsentStep itself must still hold the same
 * Terms/Privacy acceptance — the invariant, relocated, never weakened.
 *
 * The two suites split because vitest runs under a node environment (no DOM), so
 * clicking "continue" to advance setupView → 'control' can't be simulated: the
 * initial static paint is the setup form. The markup asserts the form's forward
 * seam; a source assertion pins the wizard↔ConsentStep binding that seam leads to,
 * so deleting the control-view branch (which would strand the email cohort on a
 * blank view) fails a test instead of passing green.
 */
describe('OnboardingWizard — Phase C consent gate (email cohort)', () => {
  const html = renderPhaseC();

  it('the setup form leads forward with a disabled continue + a plain blocked reason, never a silent dead-end', () => {
    expect(html).toContain('continue →');
    // First paint has one empty child, so the continue is gated and the reason is
    // shown — the button is never a silent dead-end.
    expect(html).toContain('disabled=""');
    // The apostrophe is HTML-escaped in the rendered markup.
    expect(html).toContain('add each child&#x27;s name and date of birth to continue.');
    // The old inline agreement checkbox no longer lives on the setup form itself —
    // it moved to the consent step.
    expect(html).not.toContain('I agree to the');
  });

  it('the wizard renders ConsentStep for the consent view (the form leads INTO it, not a dead-end)', () => {
    expect(wizardSource).toContain('<ConsentStep');
    expect(wizardSource).toContain("setupView === 'control'");
  });

  it('the consent step carries the Terms/Privacy acceptance and its "agree" action', () => {
    const consent = renderToStaticMarkup(
      createElement(ConsentStep, { onAgree: () => {}, saving: false }),
    );
    expect(consent).toContain('href="/terms"');
    expect(consent).toContain('href="/privacy"');
    expect(consent).toContain('Terms of Service');
    expect(consent).toContain('Privacy Policy');
    expect(consent.toLowerCase()).toContain('agree');
    // Human copy — never the raw error code the server returns.
    expect(consent).not.toContain('tos_required');
  });
});
