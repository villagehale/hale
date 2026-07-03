import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BOOK_CHECKUP_INTENT, BookButton, buildBookRequest } from './book-button';
import { actionTypeForIntent } from '~/lib/coach/action-intent';

/**
 * The book button is no longer a dead-end intent log — it routes the parent's
 * "help me book" through the EXISTING approval engine (POST /api/coach/action →
 * draftInlineAction), producing a calendar-event draft HELD for approval (rule
 * #4). It never claims a booking happened; the copy stays honest and, on success,
 * points the parent at their approvals.
 */

const CHILD_ID = '33333333-3333-4333-8333-333333333333';

describe('buildBookRequest — routes through the real gate as book_checkup', () => {
  it('targets POST /api/coach/action with the book_checkup intent and the child scope', () => {
    const req = buildBookRequest('6-month check-up', CHILD_ID);

    expect(req.url).toBe('/api/coach/action');
    expect(req.body.intentKind).toBe(BOOK_CHECKUP_INTENT);
    expect(req.body.focusedChildId).toBe(CHILD_ID);
    // The engine's server-side trust boundary must know this intent and map it to a
    // real calendar-event action — otherwise the route rejects it as unknown.
    expect(actionTypeForIntent(req.body.intentKind)).toBe('create_calendar_event');
  });

  it('carries the health item as the source answer (the draft rationale)', () => {
    const req = buildBookRequest('2-year immunizations', CHILD_ID);
    expect(req.body.sourceAnswer).toContain('2-year immunizations');
  });

  it('omits focusedChildId for a family-wide item (no child)', () => {
    const req = buildBookRequest('flu shots', undefined);
    expect(req.body).not.toHaveProperty('focusedChildId');
  });
});

describe('BookButton — honest, held-for-approval copy', () => {
  it('offers to help book (never claims it booked) and starts enabled', () => {
    const html = renderToStaticMarkup(
      createElement(BookButton, { what: '6-month check-up', childId: CHILD_ID }),
    );
    expect(html.toLowerCase()).toContain('help you book');
    expect(html).not.toContain('disabled');
    // No fake "booked" success ever renders in the idle state.
    expect(html.toLowerCase()).not.toContain('booked');
  });
});
