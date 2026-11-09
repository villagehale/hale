import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeleteAccountButton, DeleteConfirm } from './delete-account-button';

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

/**
 * The confirm step, rendered on its own because a static render cannot click the ask.
 * It carries the full explanation the card leaves out, and both of its controls are
 * real buttons in the caller's classes: the portal resets `button`, so the old `link`
 * class read as plain text there.
 */
describe('DeleteConfirm — the step after the ask', () => {
  const confirm = (leaving: boolean) =>
    renderToStaticMarkup(
      createElement(DeleteConfirm, {
        leaving,
        state: 'confirming',
        buttonClassName: 'ask-class',
        cancelClassName: 'cancel-class',
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );

  it('explains the family erasure and offers a real cancel button', () => {
    const html = confirm(false);
    expect(html).toContain('your kids’ profiles');
    expect(html).toContain('privacy@villagehale.com');
    expect(html).toMatch(/<button[^>]*class="ask-class"[^>]*>yes, delete my account<\/button>/);
    expect(html).toMatch(/<button[^>]*class="cancel-class"[^>]*>keep my account<\/button>/);
    expect(html).not.toContain('class="link"');
  });

  it('keeps the co-parent’s own words for leaving', () => {
    const html = confirm(true);
    expect(html).toContain('right away');
    expect(html).toMatch(/<button[^>]*class="cancel-class"[^>]*>stay in this family<\/button>/);
    expect(html).not.toContain('your kids’ profiles');
  });
});
