import { UsersRound } from 'lucide-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FamilyHubCard } from './family-hub-card';

/**
 * A hub tile's badge is the AI-orange "needs your eye" pill, and it must reflect a
 * REAL count — the pill renders only for a positive number. This guards the honest
 * contract the Family hub relies on: the Approvals tile shows its live pending
 * count, while a tile with no unread concept (Messages) passes no badge and so
 * shows none — never a hardcoded number to match the mockup. The whole tile is one
 * link, so it also can't lie about being clickable.
 */
function render(props: { badge?: number }): string {
  return renderToStaticMarkup(
    createElement(FamilyHubCard, {
      icon: UsersRound,
      title: 'Approvals',
      subtitle: 'Actions waiting for you',
      href: '/approvals',
      badge: props.badge,
    }),
  );
}

const PILL = 'bg-apricot';

describe('FamilyHubCard', () => {
  it('renders the whole tile as a link to its href', () => {
    expect(render({ badge: 2 })).toContain('href="/approvals"');
  });

  it('shows the orange count pill with the exact positive count', () => {
    const html = render({ badge: 3 });
    expect(html).toContain(PILL);
    expect(html).toContain('>3</span>');
  });

  it('omits the badge entirely for a zero count (nothing waiting)', () => {
    const html = render({ badge: 0 });
    expect(html).not.toContain(PILL);
  });

  it('omits the badge when no count is passed (a tile with no unread concept, e.g. Messages)', () => {
    const html = render({});
    expect(html).not.toContain(PILL);
  });
});
