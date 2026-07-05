import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChildScope } from './child-scope';
import {
  type ChildScopeVariant,
  type ScopeChild,
  optionValues,
  scopeChildren,
} from './child-scope-core';

/**
 * ChildScope — the shared per-child scope selector. The repo's render idiom is
 * static HTML (no jsdom); these tests guard the two things that regress silently
 * in markup: whole-family is always the FIRST option, and each variant carries the
 * CORRECT ARIA role. The onChange value contract (which value each option emits)
 * is proven directly against optionValues — the exact array every variant maps
 * over and hands to onChange by index.
 */

const NADIA = '11111111-1111-4111-8111-111111111111';
const OMAR = '22222222-2222-4222-8222-222222222222';
const KIDS: ScopeChild[] = [
  { id: NADIA, label: 'Nadia' },
  { id: OMAR, label: 'Omar' }, // teen — NAME shown on the chip (policy 1)
];

function render(variant: ChildScopeVariant, value: string | null): string {
  return renderToStaticMarkup(
    createElement(ChildScope, {
      variant,
      legend: 'who is this for',
      kids: KIDS,
      value,
      onChange: vi.fn(),
    }),
  );
}

describe('ChildScope — whole-family is always first', () => {
  it.each<ChildScopeVariant>(['filter', 'tabs', 'select'])(
    '%s renders whole family before any child',
    (variant) => {
      const html = render(variant, null);
      const familyAt = html.indexOf('whole family');
      const nadiaAt = html.indexOf('Nadia');
      expect(familyAt).toBeGreaterThanOrEqual(0);
      expect(nadiaAt).toBeGreaterThan(familyAt);
    },
  );

  it('shows each child by NAME on the chip — two teens are never both "your teen" (policy 1)', () => {
    // Two teenagers whose names the parent entered must read as distinct chips —
    // the scope selector disambiguates by name, not a shared "your teen" label.
    const twoTeens: ScopeChild[] = [
      { id: NADIA, label: 'Maya' },
      { id: OMAR, label: 'Noah' },
    ];
    const html = renderToStaticMarkup(
      createElement(ChildScope, {
        variant: 'filter',
        legend: 'who is this for',
        kids: twoTeens,
        value: null,
        onChange: vi.fn(),
      }),
    );
    expect(html).toContain('Maya');
    expect(html).toContain('Noah');
    // Never the anonymous shared label when the names are known.
    expect(html).not.toContain('your teen');
  });
});

describe('ChildScope — correct ARIA role per variant', () => {
  it('filter is a fieldset of aria-pressed toggles (no tablist/radiogroup)', () => {
    const html = render('filter', NADIA);
    expect(html).toContain('<fieldset');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="radiogroup"');
  });

  it('tabs is a tablist of role=tab with aria-selected (roving tabindex)', () => {
    const html = render('tabs', NADIA);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    // The selected tab is the only one in the tab order.
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('tabindex="-1"');
  });

  it('select is a radiogroup of role=radio with aria-checked', () => {
    const html = render('select', OMAR);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('role="radio"');
    expect(html).toContain('aria-checked="true"');
  });
});

describe('scopeChildren — name-bearing chip label (policy 1)', () => {
  it('carries every child by their given name — including a teen (parent entered it)', () => {
    // Policy 1: the parent named their teen, so the scope chip shows that name.
    // Two teens must be distinguishable — never two identical "your teen" chips.
    expect(
      scopeChildren([
        { id: NADIA, name: 'Nadia', stage: 'child' },
        { id: OMAR, name: 'Omar', stage: 'teenager' },
      ]),
    ).toEqual([
      { id: NADIA, label: 'Nadia' },
      { id: OMAR, label: 'Omar' },
    ]);
  });

  it('preserves order and passes a null name through as null (no name on file → "your teen" at render)', () => {
    expect(
      scopeChildren([
        { id: NADIA, name: null, stage: 'newborn' },
        { id: OMAR, name: null, stage: 'teenager' },
      ]),
    ).toEqual([
      { id: NADIA, label: null },
      { id: OMAR, label: null },
    ]);
  });
});

describe('ChildScope — onChange value contract', () => {
  it('emits null for whole family first, then each child id in order', () => {
    // Every variant renders optionValues(children) in order and calls
    // onChange(optionValues[i]) for the option at index i, so this IS the set of
    // values onChange can emit, whole-family (null) first.
    expect(optionValues(KIDS)).toEqual([null, NADIA, OMAR]);
  });

  it('with no children, the only emittable value is whole family (null)', () => {
    expect(optionValues([])).toEqual([null]);
  });
});
