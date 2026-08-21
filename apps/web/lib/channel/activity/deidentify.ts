import type { Municipality } from '@hale/db';
import type { FamilyStage } from '@hale/types';
import { nameAnywhere } from '~/lib/channel/coach/reply';
import { scrubResidualPii } from '~/lib/channel/off-domain/medical';

/**
 * PHASE 0 OF THE ACTIVITY LANE — de-identify BEFORE the search, deterministically.
 *
 * The medical lane's phase 0 is a blind LLM sanitizer with a regex backstop under it,
 * because there the only thing that knows the child's name is the parent's raw sentence.
 * Here Hale KNOWS the names — they are rows — so the stronger check is available and the
 * model call is not. That is the whole difference, and it runs the right way: a check
 * against the household's actual names cannot be talked out of firing, costs no tokens,
 * and adds no latency to a turn a parent is waiting on.
 *
 * WHAT MAY CROSS THE BORDER (rule #1 / PIPEDA / Law 25 — `web_search` is Anthropic's US
 * server tool, so every field here is a cross-border disclosure):
 *
 *   · the ACTIVITY SUBJECT — "toddler gymnastics", "indoor swim lessons". Model-supplied
 *     free text, so it is scrubbed and then CHECKED against every name in the household.
 *   · the WINDOW — "this fall", "September to December". Same treatment, same reason.
 *   · the TOWN — code-supplied from `families.area_coarse` via the FSA table. A
 *     municipality, never a postal code and never a street. The model cannot supply it,
 *     which is what makes "coarse location only" a property rather than an instruction.
 *   · the STAGE WORD — code-supplied from the child's date of birth via `deriveStage`.
 *     A band, never an age and never a DOB, for the reason the medical lane keeps a band:
 *     an activity that fits a two-year-old does not fit a nine-year-old, and the band is
 *     the least identifying thing that carries that.
 *
 * WHAT NEVER DOES: a name, an exact age, a date of birth, a postal code, an address, a
 * school, a phone number, an email. The first is REFUSED (see below) and the rest are
 * stripped by {@link scrubResidualPii}, the same deterministic backstop the medical lane
 * runs — imported rather than copied, so the two lanes cannot drift about what an
 * identifier is.
 *
 * WHY A NAME IS A REFUSAL AND NOT A REDACTION. Everything else on that list is noise a
 * search is better off without, so removing it costs nothing. A name is different: if the
 * model put one in the subject, the subject it wrote is about a CHILD rather than about an
 * activity, and quietly deleting the word would send a search for "gymnastics for  in
 * Halton Hills" and call that a de-identified query. The refusal carries a sentence the
 * model reads mid-turn and answers by calling again with a subject that is about the
 * thing, which is the same recompose loop `offer_full_plan` runs on a bad offer sentence.
 */

/** The subject's ceiling. A web query longer than this is not a search, it is a parent's
 * whole message pasted into one — which is both a worse search and a rule-#1 hazard, since
 * the raw message is precisely what must not cross the border. */
export const MAX_SUBJECT_CHARS = 120;

/** Why a query may not be sent. Each one is a different fix, so none of them is folded
 * into the others (rule #11). */
export type ActivityDeidRefusal = 'empty_subject' | 'subject_too_long' | 'names_a_person';

/**
 * A query that has cleared phase 0 — the ONLY shape the search is allowed to see.
 *
 * There is no field on it that could hold a name, an age or an address, which is the
 * structural half of the promise: the search stage takes this type and nothing else, so
 * "the raw message never crosses the border" is not a discipline anybody has to keep.
 */
export interface ActivityQuery {
  subject: string;
  window: string | null;
  /** The family's town, in the words a search engine understands. Null when the postal
   * code on file names no single municipality — see {@link townFor}. */
  town: string | null;
  /** The coarse band, or null when no child was named and the family has none on file. */
  stage: FamilyStage | null;
}

export type ActivityDeidResult =
  | { ok: true; query: ActivityQuery }
  | { ok: false; refusal: ActivityDeidRefusal };

/**
 * `halton_hills` → `Halton Hills`. Derived from the enum value rather than looked up in
 * a second table: every one of the fifteen covered municipalities is its own display name
 * with the underscores opened out, and a hand-written map would be a second place for a
 * town to be spelled — one that can disagree with the FSA table that produced it.
 */
export function townFor(municipality: Municipality): string {
  return municipality
    .split('_')
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

/** True when `text` names any member of this household, as a whole word in any alphabet
 * ({@link nameAnywhere} — the boundary the outbound redactor uses, so the set of names
 * this refuses is exactly the set that one replaces). */
export function namesAPerson(text: string, householdNames: readonly string[]): boolean {
  return householdNames.some((name) => {
    const trimmed = name.trim();
    return trimmed !== '' && nameAnywhere(trimmed).test(text);
  });
}

/**
 * Turn what the coach asked for into what may be searched, or refuse.
 *
 * The order is load-bearing: SCRUB first, then check for a name. A scrub that ran second
 * could turn "Noah is 3 years old" into "Noah is [redacted]" and then find the name in it
 * — correct, but by luck. Scrubbing first means the name check runs on exactly the string
 * that would have been sent.
 */
export function deidentifyActivityQuery(input: {
  subject: string;
  window?: string | null;
  municipality: Municipality | null;
  stage: FamilyStage | null;
  householdNames: readonly string[];
}): ActivityDeidResult {
  const subject = scrubResidualPii(input.subject).replace(/\s+/g, ' ').trim();
  if (subject === '') return { ok: false, refusal: 'empty_subject' };
  if (subject.length > MAX_SUBJECT_CHARS) return { ok: false, refusal: 'subject_too_long' };

  const rawWindow = input.window?.trim() ?? '';
  const window =
    rawWindow === '' ? null : scrubResidualPii(rawWindow).replace(/\s+/g, ' ').trim() || null;

  if (namesAPerson(subject, input.householdNames)) {
    return { ok: false, refusal: 'names_a_person' };
  }
  if (window !== null && namesAPerson(window, input.householdNames)) {
    return { ok: false, refusal: 'names_a_person' };
  }

  return {
    ok: true,
    query: {
      subject,
      window,
      town: input.municipality === null ? null : townFor(input.municipality),
      stage: input.stage,
    },
  };
}

/** The sentence the model reads when phase 0 refuses — it answers by calling again.
 * Never echoes the subject back: the refusal exists because that string held something
 * that must not be repeated (rule #1). */
export function refusalSentence(refusal: ActivityDeidRefusal): string {
  switch (refusal) {
    case 'empty_subject':
      return 'That search had no subject. Call find_activities again and say what kind of activity to look for.';
    case 'subject_too_long':
      return `That subject is longer than ${MAX_SUBJECT_CHARS} characters. Call find_activities again with a short phrase for the activity itself, not the parent's whole message.`;
    case 'names_a_person':
      return 'That subject names somebody in the family, and a name never goes to a search. Call find_activities again with the activity alone - the age band travels with it already.';
  }
}
