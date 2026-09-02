import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AddCoParentCard, ONE_SEAT_LINE } from './add-coparent-card';

// The card calls the 'use server' join actions and the router; stub both so the
// static render never drags the auth/db chain in (the replay-pii-masking pattern).
vi.mock('~/app/(authed)/family/join-actions', () => ({
  mintCoParentJoinLink: vi.fn(),
  revokeCoParentJoinLinks: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

/**
 * The /family "Add your co-parent" card, in its two persistent states. The raw link
 * only ever exists in the post-mint modal (client state a static render cannot
 * reach), so what is pinned here is the structural honesty: the open-invite state
 * shows STATUS + Revoke and never a link, and the quota line tells the truth the
 * rail enforces (single-use, 7 days).
 */
describe('AddCoParentCard', () => {
  it('offers Create link with the full-access explainer when no link is out', () => {
    const html = renderToStaticMarkup(h(AddCoParentCard, { openInvite: null }));
    expect(html).toContain('Add your co-parent');
    expect(html).toContain('full access, free');
    expect(html).toContain('Create link');
    expect(html).not.toContain('Revoke');
  });

  it('shows status + Revoke + Create a new link while a link is out — never the code', () => {
    const html = renderToStaticMarkup(
      h(AddCoParentCard, { openInvite: { expiresAt: '2026-09-04T12:00:00.000Z' } }),
    );
    expect(html).toContain('A link is out');
    expect(html).toContain('Sep');
    expect(html).toContain('Revoke');
    expect(html).toContain('Create a new link');
    // Only the digest is stored, so the persistent card CANNOT show a link.
    expect(html).not.toContain('join-');
    expect(html).not.toContain('/text?s=');
  });

  it('keeps the quota line honest about what the rail enforces', () => {
    expect(ONE_SEAT_LINE).toContain('One link, one seat');
    expect(ONE_SEAT_LINE).toContain('expires after 7 days');
  });
});
