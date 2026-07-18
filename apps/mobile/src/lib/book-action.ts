/**
 * The honest "Add to calendar" wiring for a curated health item, mirrored from the
 * web BookButton (`apps/web/components/hale/book-button.tsx`). Tapping it does NOT
 * write a calendar — expo-calendar isn't installed and no mobile calendar executor
 * exists. Instead it routes the item through the SAME approval engine the web uses:
 * POST /api/coach/action drafts a create_calendar_event action HELD at
 * drafted_for_approval (rule #4), reviewed (rule #3) and audited (rule #6). The
 * parent then approves it on the Approvals surface. So the success copy is "added to
 * your approvals", never "added to Google Calendar" — no false integration claim.
 *
 * The route lives under /api/ so the mobile Bearer bridge authenticates it exactly
 * like every other call (precedent: the app already POSTs the shared
 * /api/actions/:id/approve). Pure + exported so the intent wiring is unit-tested
 * without a native runtime.
 */

/** The server-validated intent token that maps to create_calendar_event
 * (action-intent.ts). A data boundary — the engine rejects anything outside its
 * closed set, so this must be the exact string, never a paraphrase. */
export const BOOK_CHECKUP_INTENT = 'book_checkup';

/** The shared approval-draft route (not an /api/mobile/* alias) — reachable from the
 * native client through the Edge Bearer bridge, same as /api/actions/:id/approve. */
export const BOOK_ACTION_PATH = '/api/coach/action';

export interface BookRequestBody {
  intentKind: string;
  /** The rationale carried onto the draft — the parent's implied ask. */
  sourceAnswer: string;
  /** Present only for a child-scoped item; a family-wide item omits it (the route
   * drops an unknown child to null anyway — rule #1). */
  focusedChildId?: string;
}

export function buildBookRequestBody(what: string, childId: string | null): BookRequestBody {
  return {
    intentKind: BOOK_CHECKUP_INTENT,
    sourceAnswer: `Help me book: ${what}`,
    ...(childId ? { focusedChildId: childId } : {}),
  };
}
