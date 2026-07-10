import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AccountPreferencesCard } from './account-preferences-card';

/**
 * The Preferences card's HONESTY contract (rule #1): it renders ONLY the two
 * display preferences the `users` row actually holds — Units and first-day-of-week
 * — and must NEVER surface a temperature control (no data backs it). Both controls
 * offer both options, so every rendered value is a real, writable choice.
 *
 * The card imports the setPreferencesAction server action (next-auth → next/server),
 * so it's stubbed for this markup-only test — the same pattern the profile-card and
 * plan tests use.
 */
vi.mock('~/lib/family/children-actions', () => ({
  setPreferencesAction: vi.fn(),
}));

function render(): string {
  return renderToStaticMarkup(
    createElement(AccountPreferencesCard, {
      profile: {
        name: 'Alex Dong',
        email: 'alex@example.com',
        timezone: 'America/Toronto',
        locale: 'en-CA',
        units: 'metric',
        weekStartDay: 1,
      },
    }),
  );
}

describe('AccountPreferencesCard', () => {
  it('renders both Units options', () => {
    const html = render();
    expect(html).toContain('Metric');
    expect(html).toContain('Imperial');
  });

  it('renders both first-day-of-week options', () => {
    const html = render();
    expect(html).toContain('Monday');
    expect(html).toContain('Sunday');
  });

  it('shows the units helper detail so the choice is unambiguous', () => {
    expect(render()).toContain('Metric (kg, cm)');
  });

  it('never renders a temperature control — no data backs it (rule #1)', () => {
    const html = render().toLowerCase();
    expect(html).not.toContain('temperature');
    expect(html).not.toContain('°c');
    expect(html).not.toContain('°f');
  });

  it('marks the stored preferences as the pressed options', () => {
    const html = render();
    expect(html).toContain('aria-pressed="true"');
  });
});
