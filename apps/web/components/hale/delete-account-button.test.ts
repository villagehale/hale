import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeleteAccountButton } from './delete-account-button';

/**
 * VIL-355 · the ASK has to be the one the route will answer.
 *
 * This is the most irreversible button in the product, and what it does depends on the
 * seat: the primary parent schedules the household's erasure, a co-parent leaves, a
 * scoped caregiver has no erasure of their own, and somebody holding seats in two
 * households gets no answer at all — the route 409s rather than letting heap order pick
 * between deleting their children's history and departing the other family.
 *
 * That last case was the one the card got wrong. The page resolved ONE family to choose
 * its copy, so a separated parent was shown a role-specific promise, clicked it, and
 * only then met the honest "which one did you mean". Nothing wrong was written — the
 * promise just was not the one that would be kept.
 */
function render(role: Parameters<typeof DeleteAccountButton>[0]['role']): string {
  return renderToStaticMarkup(createElement(DeleteAccountButton, { role }));
}

describe('DeleteAccountButton — the ask matches the seat', () => {
  it('asks a two-household viewer which family they mean, before anything is clicked', () => {
    const html = render('ambiguous');

    expect(html).toContain('more than one family');
    expect(html).toContain('privacy@villagehale.com');
    // No offer at all: the route cannot answer this, so nothing here may look clickable.
    expect(html).not.toContain('delete my account');
    expect(html).not.toContain('leave this family');
    expect(html).not.toContain('<button');
  });

  // The positive controls: without them the assertions above pass on a component that
  // renders nothing for anybody.
  it('offers the primary parent the family erasure, and the co-parent leaving', () => {
    expect(render('primary_parent')).toContain('delete my account');
    expect(render('co_parent')).toContain('leave this family');
  });

  it('offers a scoped caregiver nothing, because the route would refuse them', () => {
    const html = render('scoped');
    expect(html).toContain('belongs to its parents');
    expect(html).not.toContain('<button');
  });
});
