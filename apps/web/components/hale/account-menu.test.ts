import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountMenuView } from './account-menu-view';

/**
 * The account chip shows the signed-in parent and their family identity (Hale's
 * two-parent model). Its menu holds the destinations + appearance, with Sign out
 * — an account action — only for a real session. Rendered to static markup (the
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
      familyName: 'the Okafor household',
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
  it('shows the parent name and family identity on the chip', () => {
    const html = render();
    expect(html).toContain('Maya');
    expect(html).toContain('the Okafor household');
    expect(html).toContain('aria-haspopup="menu"');
  });

  it('falls back to neutral labels when identity is absent (onboarding incomplete)', () => {
    const html = render({ parentName: null, familyName: null });
    expect(html).toContain('your account');
    expect(html).toContain('your family');
  });

  it('renders no menu and reports collapsed when closed', () => {
    const html = render({ open: false });
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain('sign out');
  });

  it('opens to settings, history, appearance, and sign out when open', () => {
    const html = render({ open: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="menu"');
    expect(html).toContain('settings');
    expect(html).toContain('history');
    expect(html).toContain('appearance');
    expect(html).toContain('sign out');
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
