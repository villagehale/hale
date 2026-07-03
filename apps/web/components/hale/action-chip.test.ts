import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActionChip, buildActionRequest } from './action-chip';

/**
 * A gated action chip drafts through the EXISTING approval engine, scoped to the
 * child the SOURCE TURN was asked about — NOT the live scope chip the parent may
 * have moved since. The Timeline therefore passes `turn.childId` (the turn's own
 * scope), so a historical child-scoped turn always drafts for that child even when
 * the conversation is now viewed under whole-family scope (mirrors how
 * InputIntentWidgets is wired to `turn.childId`).
 */

const CHILD_A = '11111111-1111-4111-8111-111111111111';

describe('buildActionRequest — the child scope the chip drafts under', () => {
  it('drafts for the turn child even when the live scope has moved to the whole family', () => {
    // The turn was asked about CHILD_A. Even though the conversation is now viewed
    // under whole-family scope, the chip must draft for CHILD_A — so the request is
    // built from the turn's child, not null.
    const req = buildActionRequest('book_checkup', CHILD_A, 'source answer');

    expect(req.url).toBe('/api/coach/action');
    expect(req.body.intentKind).toBe('book_checkup');
    expect(req.body.focusedChildId).toBe(CHILD_A);
  });

  it('omits focusedChildId for a genuinely whole-family turn (null scope)', () => {
    const req = buildActionRequest('find_activities', null, 'source answer');
    expect(req.body).not.toHaveProperty('focusedChildId');
  });
});

describe('ActionChip — honest, held-for-approval copy', () => {
  it('shows the intent label and never claims the action happened', () => {
    const html = renderToStaticMarkup(
      createElement(ActionChip, {
        intent: { kind: 'book_checkup', label: 'help me book this', actionType: 'create_calendar_event' },
        focusedChildId: CHILD_A,
        sourceAnswer: 'around six months',
      }),
    );
    expect(html).toContain('help me book this');
    expect(html.toLowerCase()).not.toContain('done');
  });
});
