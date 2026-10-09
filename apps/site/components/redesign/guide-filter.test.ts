import { type ReactElement, type ReactNode, createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * GuideFilter's hydration. useState is a one-slot store. useEffect is queued
 * and run after the render that scheduled it, which is when a real mount would
 * read `?stage=`. The component is then called again so the tree shows that
 * state. No DOM.
 */

let slot: unknown;
const effects: Array<() => void> = [];
const listeners = new Map<string, () => void>();

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (slot === undefined) slot = initial;
      return [
        slot,
        (next: unknown) => {
          slot = typeof next === 'function' ? (next as (prev: unknown) => unknown)(slot) : next;
        },
      ];
    },
    useEffect: (effect: () => void) => {
      effects.push(effect);
    },
  };
});

const { GuideFilter } = await import('./guide-filter.js');

const stages = [
  { param: 'newborn', label: 'Newborn', count: 2 },
  { param: 'toddler', label: 'Toddler', count: 0 },
  { param: 'school-age', label: 'School age', count: 1 },
  { param: 'teenager', label: 'Teenager', count: 1 },
] as const;

function cards() {
  return [
    createElement('article', { 'data-stage': 'newborn', key: 'n1' }, 'n1'),
    createElement('article', { 'data-stage': 'newborn', key: 'n2' }, 'n2'),
    createElement('article', { 'data-stage': 'school-age', key: 's1' }, 's1'),
    createElement('article', { 'data-stage': 'teenager', key: 'te1' }, 'te1'),
  ];
}

function props() {
  return {
    groupLabel: 'Filter guides by stage',
    allLabel: 'All stages',
    total: 4,
    stages,
    statusTemplate: 'Showing {n} of {total} guides',
    emptyHeading: 'No guides for this stage yet.',
    seeAllLabel: 'See all stages',
    children: cards(),
  };
}

interface LocationStub {
  pathname: string;
  search: string;
  hash: string;
}

function installWindow(search: string): {
  location: LocationStub;
  replaceState: ReturnType<typeof vi.fn>;
} {
  const location: LocationStub = { pathname: '/answers', search, hash: '#list' };
  const replaceState = vi.fn((_state: null, _title: string, href: string) => {
    const url = new URL(href, 'http://local');
    location.pathname = url.pathname;
    location.search = url.search;
    location.hash = url.hash;
  });
  vi.stubGlobal('window', {
    location,
    history: { replaceState },
    addEventListener: (type: string, fn: () => void) => {
      listeners.set(type, fn);
    },
    removeEventListener: () => {},
  });
  return { location, replaceState };
}

/** Render, run the effect the render scheduled, then render the state it stored. */
function paint(): ReactElement {
  GuideFilter(props());
  const effect = effects.pop();
  effects.length = 0;
  effect?.();
  return GuideFilter(props()) as ReactElement;
}

function walk(node: ReactNode, visit: (el: ReactElement) => void) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isValidElement(node)) return;
  visit(node);
  walk((node.props as { children?: ReactNode }).children, visit);
}

interface NodeProps {
  className?: string;
  'aria-pressed'?: boolean;
  'data-stage'?: string;
  onClick?: () => void;
  hidden?: boolean;
}

function buttons(tree: ReactElement): NodeProps[] {
  const found: NodeProps[] = [];
  walk(tree, (el) => {
    if (el.type === 'button') found.push(el.props as NodeProps);
  });
  return found;
}

function articles(tree: ReactElement): NodeProps[] {
  const found: NodeProps[] = [];
  walk(tree, (el) => {
    if (el.type === 'article') found.push(el.props as NodeProps);
  });
  return found;
}

describe('GuideFilter hydrates from ?stage=', () => {
  it('selects the chip in the query and hides the other cards', () => {
    slot = undefined;
    effects.length = 0;
    listeners.clear();
    installWindow('?stage=newborn&utm=1');
    const tree = paint();
    const html = renderToStaticMarkup(tree);

    const chips = buttons(tree).filter((button) => button.className === 'sp-chip');
    const pressed = chips.find((button) => button['aria-pressed'] === true);
    expect(pressed?.['data-stage']).toBe('newborn');
    expect(chips.map((button) => button['data-stage'])).toEqual([
      'all',
      'newborn',
      'school-age',
      'teenager',
    ]);
    expect(html).toContain('Showing 2 of 4 guides: Newborn');
    expect(html).not.toContain('No guides for this stage yet.');

    const visible = articles(tree).filter((article) => article.hidden !== true);
    expect(visible).toHaveLength(2);
    expect(visible.every((article) => article['data-stage'] === 'newborn')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('falls back to All stages for an unknown stage value', () => {
    slot = undefined;
    effects.length = 0;
    installWindow('?stage=child');
    const tree = paint();
    const chips = buttons(tree).filter((button) => button.className === 'sp-chip');
    expect(chips.find((button) => button['aria-pressed'] === true)?.['data-stage']).toBe('all');
    expect(articles(tree).every((article) => article.hidden !== true)).toBe(true);
    expect(renderToStaticMarkup(tree)).toContain('Showing 4 of 4 guides');
    expect(renderToStaticMarkup(tree)).not.toContain('Showing 4 of 4 guides:');
    vi.unstubAllGlobals();
  });

  it('shows the empty guard for a known stage that has no guides', () => {
    slot = undefined;
    effects.length = 0;
    installWindow('?stage=toddler');
    const tree = paint();
    const html = renderToStaticMarkup(tree);
    const chips = buttons(tree).filter((button) => button.className === 'sp-chip');

    expect(chips.map((button) => button['data-stage'])).not.toContain('toddler');
    expect(html).toContain('No guides for this stage yet.');
    expect(html).toContain('See all stages');
    expect(html).toContain('Showing 0 of 4 guides: Toddler');
    expect(
      articles(tree).every(
        (article) => article.hidden === true || article.className?.includes('sp-filter-empty'),
      ),
    ).toBe(true);
    vi.unstubAllGlobals();
  });

  it('writes the query with replaceState and ignores a second press of the same chip', () => {
    slot = undefined;
    effects.length = 0;
    listeners.clear();
    const { replaceState } = installWindow('?utm=1');
    const tree = paint();
    const chips = buttons(tree).filter((button) => button.className === 'sp-chip');
    const newborn = chips.find((button) => button['data-stage'] === 'newborn');
    newborn?.onClick?.();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/answers?utm=1&stage=newborn#list');

    replaceState.mockClear();
    const selected = paint();
    const again = buttons(selected).find(
      (button) => button.className === 'sp-chip' && button['data-stage'] === 'newborn',
    );
    again?.onClick?.();
    expect(replaceState).not.toHaveBeenCalled();

    const all = buttons(selected).find((button) => button['data-stage'] === 'all');
    all?.onClick?.();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/answers?utm=1#list');
    vi.unstubAllGlobals();
  });

  it('follows the back button through popstate', () => {
    slot = undefined;
    effects.length = 0;
    listeners.clear();
    const { location } = installWindow('?stage=newborn');
    paint();
    location.search = '?stage=teenager';
    listeners.get('popstate')?.();
    const tree = GuideFilter(props()) as ReactElement;
    const pressed = buttons(tree).find((button) => button['aria-pressed'] === true);
    expect(pressed?.['data-stage']).toBe('teenager');
    vi.unstubAllGlobals();
  });
});
