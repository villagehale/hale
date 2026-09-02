import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountMenuView } from './account-menu-view';

/**
 * The account chip shows the signed-in parent's name over the family's plan label
 * (per the desktop handoff — "Free plan" / "Plus" / "Family"). Its menu holds NO
 * destinations — appearance, plus Sign out (an account action) for a real session.
 * Rendered to static markup (the stateful wrapper owns open-state and
 * dismissal; this view takes `open` as a prop, so "toggles open/closed" is testable
 * as "renders the menu only when open"). Same render-to-HTML approach as the village
 * feed test.
 */
function render(
  overrides: Partial<Parameters<typeof AccountMenuView>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(AccountMenuView, {
      open: false,
      parentName: 'Maya',
      planTier: 'free',
      canSignOut: true,
      menuId: 'acct',
      onToggle: () => {},
      onSignOut: () => {},
      ...overrides,
    }),
  );
}

describe('AccountMenuView', () => {
  it('shows the parent name over the plan label on the chip', () => {
    const html = render();
    expect(html).toContain('Maya');
    expect(html).toContain('Free plan');
    expect(html).not.toContain('View profile');
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it('shows the tier name as the plan label for a paid tier', () => {
    expect(render({ planTier: 'plus' })).toContain('Plus');
    expect(render({ planTier: 'family' })).toContain('Family');
  });

  it('shows the masked number as the secondary line once enrolled (Instinct chip: name + phone)', () => {
    const html = render({ maskedPhone: '+1 ••• ••• 1234' });
    expect(html).toContain('+1 ••• ••• 1234');
    // The phone replaces the plan line — one secondary line, never both.
    expect(html).not.toContain('Free plan');
  });

  it('falls back to the plan label while no number is enrolled', () => {
    const html = render({ maskedPhone: null });
    expect(html).toContain('Free plan');
  });

  it('falls back to a neutral name when identity is absent (onboarding incomplete)', () => {
    const html = render({ parentName: null });
    expect(html).toContain('your account');
  });

  it('renders no menu and reports collapsed when closed', () => {
    const html = render({ open: false });
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('sign out');
  });

  it('opens to appearance and sign out only — no destinations in the chip', () => {
    const html = render({ open: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('appearance');
    expect(html).toContain('sign out');
    // The theme control rides in the menu (its three options).
    expect(html).toContain('aria-label="Color theme"');
    // Settings is a nav stop; a second entry here gave the app two Settings. History
    // left the same way earlier (it stays reachable from Approvals). The two positive
    // assertions above are the control that this render is not simply empty.
    expect(html).not.toContain('settings');
    expect(html).not.toContain('history');
  });

  it('hides sign out when the session cannot sign out (dev preview)', () => {
    const html = render({ open: true, canSignOut: false });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('appearance');
    expect(html).not.toContain('sign out');
  });
});
