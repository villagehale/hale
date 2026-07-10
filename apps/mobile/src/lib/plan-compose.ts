import type { CreatePlanRequest } from './api-types';

/**
 * Pure composer for the native AddPlan form: turns the raw text/date inputs into the
 * create-plan wire body, or a validation error. Mirrors the web AddPlan's transform
 * (apps/web/components/hale/add-plan.tsx): a title is required (trimmed), notes are
 * trimmed-or-null, and the optional `YYYY-MM-DD` date becomes a UTC-midnight ISO
 * instant (the same bare-calendar-date encoding the web <input type="date"> produces),
 * or null. The server re-validates (createPlan → validatePlan) — this is the client
 * guard so an empty title never posts.
 */

export type ComposeError = 'title_required' | 'date_invalid';

export function composeCreatePlan(input: {
  title: string;
  notes: string;
  /** `YYYY-MM-DD` from the date field, or '' when undated. */
  scheduledFor: string;
  childId: string | null;
}): { ok: true; body: CreatePlanRequest } | { ok: false; error: ComposeError } {
  const title = input.title.trim();
  if (title.length === 0) {
    return { ok: false, error: 'title_required' };
  }
  const notes = input.notes.trim() ? input.notes.trim() : null;

  let scheduledFor: string | null = null;
  if (input.scheduledFor) {
    // Encode the bare calendar date at UTC-midnight, matching the web date input, so
    // the spine reads back the exact day the parent picked (spine reads the key in UTC).
    const at = new Date(`${input.scheduledFor}T00:00:00Z`);
    if (Number.isNaN(at.getTime())) {
      return { ok: false, error: 'date_invalid' };
    }
    scheduledFor = at.toISOString();
  }

  return {
    ok: true,
    body: { action: 'create', title, notes, scheduledFor, childId: input.childId },
  };
}
