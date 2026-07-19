import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountMenuView } from './account-menu-view';

/**
 * The account chip shows the signed-in parent's name over a "View profile" line
 * into the account page. Its menu holds the destinations + appearance, with Sign
 * out — an account action — only for a real session. Rendered to static markup (the
 * stateful wrapper owns open-state and dismissal; this view takes `open` as a
 * prop, so "toggles open/closed" is testable as "renders the menu only when
 * open"). Same render-to-HTML approach as the village feed test.
 */
function render(
  overrides: Partial<Parameters<typeof AccountMenuView>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(AccountMenuView, {
      open: false,
      parentName: 'Maya',
      canSignOut: true,
      menuId: 'acct',
      onToggle: () => {},
      onSelect: () => {},
      onSignOut: () => {},
      ...overrides,
    }),
  );
}

describe('AccountMenuView', () => {
  it('shows the parent name over a View profile line on the chip', () => {
    const html = render();
    expect(html).toContain('Maya');
    expect(html).toContain('View profile');
    expect(html).toContain('aria-haspopup="menu"');
  });

  it('falls back to a neutral name when identity is absent (onboarding incomplete)', () => {
    const html = render({ parentName: null });
    expect(html).toContain('your account');
  });

  it('renders no menu and reports collapsed when closed', () => {
    const html = render({ open: false });
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain('sign out');
  });

  it('opens to settings, appearance, and sign out when open (history moved out per the desktop handoff)', () => {
    const html = render({ open: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="menu"');
    expect(html).toContain('settings');
    expect(html).toContain('appearance');
    expect(html).toContain('sign out');
    // History is no longer in the account menu (it stays reachable from Approvals).
    expect(html).not.toContain('history');
    // The theme control rides in the menu (its three options).
    expect(html).toContain('aria-label="Color theme"');
  });

  it('hides sign out when the session cannot sign out (dev preview)', () => {
    const html = render({ open: true, canSignOut: false });
    expect(html).toContain('role="menu"');
    expect(html).toContain('settings');
    expect(html).not.toContain('sign out');
  });
});
