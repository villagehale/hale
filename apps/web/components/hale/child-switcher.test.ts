import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChildSwitcher } from './child-switcher';

// The wrapper now navigates on select via useRouter (WEB-10); stub it so the static
// render has a router (renderToStaticMarkup provides no AppRouter context).
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

/**
 * The sidebar child switcher's "Add child" must land on the surface that actually
 * has the add-child form (/family/members), not the Family hub index (/family,
 * which only links onward). The wrapper owns that default, so this renders it to
 * static markup and reads the link. With no children the chip itself IS the
 * add-child link, so the default href is visible without opening the popover.
 */
describe('ChildSwitcher default add-child destination', () => {
  it('defaults "Add child" to /family/members (the surface with the add form)', () => {
    const html = renderToStaticMarkup(createElement(ChildSwitcher, { kids: [] }));
    expect(html).toContain('href="/family/members"');
    expect(html).not.toContain('href="/family"');
  });
});
