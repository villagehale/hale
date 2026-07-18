import { describe, expect, it } from 'vitest';
import { BOOK_ACTION_PATH, BOOK_CHECKUP_INTENT, buildBookRequestBody } from './book-action';

describe('buildBookRequestBody', () => {
  it('routes a health item through the closed-set book_checkup intent', () => {
    const body = buildBookRequestBody('15-month well-baby visit', 'child-1');
    // The intent string is a server-validated data boundary — it must be the exact
    // token the engine maps to create_calendar_event, never a paraphrase.
    expect(body.intentKind).toBe('book_checkup');
    expect(BOOK_CHECKUP_INTENT).toBe('book_checkup');
    expect(body.sourceAnswer).toBe('Help me book: 15-month well-baby visit');
    expect(body.focusedChildId).toBe('child-1');
  });

  it('omits focusedChildId for a family-wide item (no child to scope)', () => {
    const body = buildBookRequestBody('Well-baby visit', null);
    expect(body).not.toHaveProperty('focusedChildId');
    expect(body.sourceAnswer).toBe('Help me book: Well-baby visit');
  });

  it('targets the shared approval-draft route (reachable via the Bearer bridge)', () => {
    expect(BOOK_ACTION_PATH).toBe('/api/coach/action');
  });
});
