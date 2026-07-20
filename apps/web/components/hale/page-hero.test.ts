import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { buildRootHeroes } from './hero-map';

// PageHero reads the live pathname; drive it from a mutable holder so each case can
// point at a different route with one mocked module.
let currentPath = '/home';
vi.mock('next/navigation', () => ({ usePathname: () => currentPath }));

const { PageHero } = await import('./page-hero');

const roots = buildRootHeroes({ greeting: 'Good evening, Alex', childName: 'Sebastian' });

function render(path: string): string {
  currentPath = path;
  return renderToStaticMarkup(createElement(PageHero, { roots, variant: 'topbar' }));
}

describe('PageHero', () => {
  it('renders a root hero as an <h1> title + subtitle', () => {
    const html = render('/home');
    expect(html).toContain('<h1');
    expect(html).toContain('Good evening, Alex');
    expect(html).toContain('happening today.');
    // No breadcrumb/back affordance on a root.
    expect(html).not.toContain('page-hero-back');
  });

  it('renders a drill as a breadcrumb + back link, not a subtitle', () => {
    const html = render('/approvals');
    expect(html).toContain('page-hero-back');
    expect(html).toContain('href="/family"');
    expect(html).toContain('Family');
    expect(html).toContain('Approvals');
    expect(html).toContain('page-hero-title-drill');
  });

  it('renders nothing outside the app surfaces', () => {
    expect(render('/sign-in')).toBe('');
  });
});
