/**
 * The Home ask bar (AskBar) GET-submits the typed question as `?q=`. /coach coerces it
 * to a bounded initial composer draft so the question is never silently dropped on
 * navigation (WEB-02) — and a crafted URL can't seed an unbounded draft. A non-string
 * param (missing, or a repeated `?q=&q=` array) yields an empty draft.
 */
export const MAX_SEEDED_DRAFT = 2000;

export function draftFromQueryParam(q: string | string[] | undefined): string {
  return typeof q === 'string' ? q.slice(0, MAX_SEEDED_DRAFT) : '';
}
