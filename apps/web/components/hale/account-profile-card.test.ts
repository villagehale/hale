import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AccountProfileCard, humanizeLocale, humanizeTimezone } from './account-profile-card';

/**
 * The Profile card's HONESTY contract (rule #1 — this product handles newborn
 * data, so never a fabricated field). The `users` row holds only name, email,
 * timezone, and locale — there is NO phone column, NO units/temperature/week-start.
 * So the card must show Name/Email/Timezone/Language and must NOT render a Phone
 * row (the mockup shows one; it has no backing store). Expected humanizations are
 * derived from the spec, not copied from code output.
 *
 * The embedded FamilyParent pulls in the setParentNameAction server action
 * (next-auth → next/server), so it's stubbed for this markup-only test — the same
 * pattern the FamilyPlan test uses.
 */
vi.mock('~/lib/family/children-actions', () => ({
  setParentNameAction: vi.fn(),
}));

function render(): string {
  return renderToStaticMarkup(
    createElement(AccountProfileCard, {
      profile: {
        name: 'Alex Dong',
        email: 'alex@example.com',
        timezone: 'America/Toronto',
        locale: 'en-CA',
      },
    }),
  );
}

describe('AccountProfileCard', () => {
  it('renders the real identity and preference rows', () => {
    const html = render();
    expect(html).toContain('Alex Dong');
    expect(html).toContain('alex@example.com');
    expect(html).toContain('Timezone');
    expect(html).toContain('Language');
  });

  it('never renders a Phone row — no phone column exists to back it (rule #1)', () => {
    expect(render()).not.toContain('Phone');
  });

  it("humanizes 'en-CA' to English (Canada)", () => {
    expect(humanizeLocale('en-CA')).toBe('English (Canada)');
  });

  it('falls back to the raw tag for an unparseable locale rather than throwing', () => {
    expect(humanizeLocale('zz')).toBe('zz');
  });

  it("humanizes 'America/Toronto' to a city with a GMT offset", () => {
    expect(humanizeTimezone('America/Toronto', 'en-CA')).toBe('Toronto (GMT-4)');
  });
});
