import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChildSwitcherView } from './child-switcher-view';

/**
 * The sidebar child switcher: the chip shows one child, the popover lists them all
 * (active one marked) and links to "Add child". Rendered to static markup the same
 * way as AccountMenuView — the stateful wrapper owns open-state, so "opens" is
 * testable as "renders the menu only when open". These assert the load-bearing
 * behaviour (real names, add-child target, the empty degrade), not incidental markup.
 */
const KIDS = [
  { id: 'a', name: 'Sebastian', ageLabel: 'toddler' },
  { id: 'b', name: 'Aurora', ageLabel: 'newborn' },
];

function render(
  overrides: Partial<Parameters<typeof ChildSwitcherView>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(ChildSwitcherView, {
      open: false,
      kids: KIDS,
      activeId: 'a',
      menuId: 'kids',
      addHref: '/family',
      onToggle: () => {},
      onSelect: () => {},
      ...overrides,
    }),
  );
}

describe('ChildSwitcherView', () => {
  it('shows the active child on the chip with its age line and a menu trigger', () => {
    const html = render();
    expect(html).toContain('Sebastian');
    expect(html).toContain('toddler');
    expect(html).toContain('aria-haspopup="menu"');
  });

  it('renders no menu when closed', () => {
    const html = render({ open: false });
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
  });

  it('opens to every child plus an Add child link into the existing add-child surface', () => {
    const html = render({ open: true });
    expect(html).toContain('role="menu"');
    expect(html).toContain('Sebastian');
    expect(html).toContain('Aurora');
    expect(html).toContain('Add child');
    expect(html).toContain('href="/family"');
    // The shown child is marked current so the popover reflects the chip.
    expect(html).toMatch(/aria-current="true"[^>]*>\s*<span[^>]*>S<\/span>/);
  });

  it('degrades to a single Add-a-child prompt with no children (never a fake name)', () => {
    const html = render({ kids: [], activeId: null });
    expect(html).toContain('Add a child');
    expect(html).toContain('href="/family"');
    expect(html).not.toContain('aria-haspopup="menu"');
  });
});
