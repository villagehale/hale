import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ChildScope,
  type ChildScopeVariant,
  type ScopeChild,
  optionValues,
  scopeChildren,
} from './child-scope';

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
  { id: OMAR, label: null }, // teen — name withheld (rule #1)
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

  it('withholds a teen name — renders "your teen", never the given name', () => {
    const html = render('filter', null);
    expect(html).toContain('your teen');
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

describe('scopeChildren — teen-safe label derivation (rule #1)', () => {
  it('keeps a non-teen name and withholds a teen name (label null)', () => {
    expect(
      scopeChildren([
        { id: NADIA, name: 'Nadia', stage: 'child' },
        { id: OMAR, name: 'Omar', stage: 'teenager' },
      ]),
    ).toEqual([
      { id: NADIA, label: 'Nadia' },
      { id: OMAR, label: null },
    ]);
  });

  it('preserves order and passes a null name through unchanged for a non-teen', () => {
    expect(scopeChildren([{ id: NADIA, name: null, stage: 'newborn' }])).toEqual([
      { id: NADIA, label: null },
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
