import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// StepChildren pulls the wizard module, which transitively imports the server actions
// (next-auth — unresolvable under vitest) + next/navigation + analytics. Stub those
// seams; static markup, so effects don't run — this is the first paint of step 3.
vi.mock('~/lib/onboarding/complete-onboarding', () => ({ completeOnboarding: vi.fn() }));
vi.mock('~/lib/onboarding/sign-in-action', () => ({ startGoogleSignIn: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('~/lib/analytics/posthog-provider', () => ({ useAnalytics: () => vi.fn() }));

import { StepChildren } from '~/app/onboarding/wizard';

type Kid = {
  id: string;
  name: string;
  lastName: string;
  dateOfBirth: string;
  gender: 'unspecified';
};

const kid = (name = ''): Kid => ({
  id: `c-${name || 'x'}`,
  name,
  lastName: '',
  dateOfBirth: '',
  gender: 'unspecified',
});

function render(kids: Kid[]): string {
  return renderToStaticMarkup(
    createElement(StepChildren, {
      headingRef: { current: null },
      kids,
      onName: vi.fn(),
      onAdd: vi.fn(),
      onRemove: vi.fn(),
      onNext: vi.fn(),
    }),
  );
}

/** The primary (btn-primary) button's own HTML, so `disabled` / label assertions
 * can't be fooled by another control on the step. */
function primaryButton(html: string): string {
  return html.match(/<button[^>]*btn-primary[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
}

/**
 * The children step (design handoff §4.1 Ob3) must ALWAYS let a parent proceed — a
 * parent who wants to add kids later shouldn't be forced to invent a child or hit
 * Skip (which skips the whole wizard). The primary button is never disabled: with a
 * named child it reads "That's everyone — continue"; with none it reads "Continue"
 * and advances (the birthday is collected post-auth at step 7, per the deferred-
 * details design). These pin the three button states.
 */
describe('StepChildren — the primary button is never a dead end', () => {
  it('no child named (single empty row): enabled "Continue", not "That\'s everyone"', () => {
    const primary = primaryButton(render([kid()]));
    expect(primary).not.toContain('disabled');
    expect(primary).toContain('Continue');
    expect(primary).not.toContain('everyone');
  });

  it('a child named: enabled "That\'s everyone — continue"', () => {
    const primary = primaryButton(render([kid('Ada')]));
    expect(primary).not.toContain('disabled');
    expect(primary).toContain('everyone');
  });

  it('several empty rows, none named: still enabled "Continue" (the reported bug)', () => {
    const primary = primaryButton(render([kid(), kid(), kid()]));
    expect(primary).not.toContain('disabled');
    expect(primary).toContain('Continue');
    expect(primary).not.toContain('everyone');
  });
});
