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
 *     free text, so it goes through {@link gateFreeText}.
 *   · the WINDOW — "this fall", "September to December". The SAME gate, the same ceiling,
 *     the same scrub, and that is the point: there are exactly two free-text fields on
 *     this payload and ONE function that produces them, so a field cannot be gated by
 *     being remembered. The window was once capped by nothing at all, and a 431-character
 *     window — a parent's whole message pasted into the second argument — crossed the
 *     border beside a subject held to 120.
 *   · the TOWN — code-supplied from `families.area_coarse` via the FSA table. A
 *     municipality, never a postal code and never a street. The model cannot supply it,
 *     which is what makes "coarse location only" a property rather than an instruction.
 *   · the STAGE WORD — code-supplied from the child's date of birth via `deriveStage`.
 *     A band, never an age and never a DOB, for the reason the medical lane keeps a band:
 *     an activity that fits a two-year-old does not fit a nine-year-old, and the band is
 *     the least identifying thing that carries that.
 *
 * WHAT NEVER DOES: a name, an exact age, a date of birth, a postal code, a street address,
 * a named school, a phone number, an email. The first is REFUSED (see below) and the rest
 * are stripped by {@link scrubResidualPii}, the same deterministic backstop the medical
 * lane runs — imported rather than copied, so the two lanes cannot drift about what an
 * identifier is, and so a class added for one lane lands in both.
 *
 * WHERE THAT LINE IS ACTUALLY DRAWN, because a doc block that overclaims is worse than
 * none: the scrub holds a street address ("42 Wallace St", "16 Bayview Drive") and a
 * school named as an institution ("St. Brigid Catholic School", "École élémentaire
 * Sainte-Marie"). It deliberately does NOT hold a bare venue name — "Cartwheel Gym" is
 * what a parent asked about and the whole reason this lane exists — and it cannot hold a
 * street written with no number. The town crosses anyway, from the record; what the scrub
 * stops is the STREET, which is the difference between a municipality and a door.
 *
 * WHY A NAME IS A REFUSAL AND NOT A REDACTION. Everything else on that list is noise a
 * search is better off without, so removing it costs nothing. A name is different: if the
 * model put one in the subject, the subject it wrote is about a CHILD rather than about an
 * activity, and quietly deleting the word would send a search for "gymnastics for  in
 * Halton Hills" and call that a de-identified query. The refusal carries a sentence the
 * model reads mid-turn and answers by calling again with a subject that is about the
 * thing, which is the same recompose loop `offer_full_plan` runs on a bad offer sentence.
 */

/** The ceiling on EVERY free-text field, not on the subject alone. Text longer than this
 * is not a search, it is a parent's whole message pasted into an argument — which is both
 * a worse search and a rule-#1 hazard, since the raw message is precisely what must not
 * cross the border. One number, because two would be two places for a field to be
 * forgotten. */
export const MAX_QUERY_FIELD_CHARS = 120;

/** Why a query may not be sent. Each one is a different fix, so none of them is folded
 * into the others (rule #11) — including which field ran long, since "say the activity in
 * a short phrase" and "say the season in a few words" are different instructions. */
export type ActivityDeidRefusal =
  | 'empty_subject'
  | 'subject_too_long'
  | 'window_too_long'
  | 'names_a_person';

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
 * THE GATE EVERY FREE-TEXT FIELD CROSSES, and the only thing that produces one.
 *
 * The order is load-bearing: SCRUB first, then check for a name. A scrub that ran second
 * could turn "Noah is 3 years old" into "Noah is [redacted]" and then find the name in it
 * — correct, but by luck. Scrubbing first means the name check runs on exactly the string
 * that would have been sent.
 *
 * The refusals it hands back are FIELD-BLIND — the caller says which field ran long,
 * because only the caller knows. That is what keeps the gate one function rather than two
 * that can disagree about what a ceiling is.
 */
function gateFreeText(
  raw: string,
  householdNames: readonly string[],
): { ok: true; value: string } | { ok: false; refusal: 'empty' | 'too_long' | 'names_a_person' } {
  const value = scrubResidualPii(raw).replace(/\s+/g, ' ').trim();
  if (value === '') return { ok: false, refusal: 'empty' };
  if (value.length > MAX_QUERY_FIELD_CHARS) return { ok: false, refusal: 'too_long' };
  if (namesAPerson(value, householdNames)) return { ok: false, refusal: 'names_a_person' };
  return { ok: true, value };
}

/**
 * Turn what the coach asked for into what may be searched, or refuse.
 *
 * Every field on the returned {@link ActivityQuery} comes from ONE of two places and there
 * is no third: {@link gateFreeText}, or the family's own record. That is the structural
 * half of the promise — not "the raw message is scrubbed before it is sent", which is a
 * thing somebody has to remember, but "there is nowhere for unscrubbed text to enter".
 */
export function deidentifyActivityQuery(input: {
  subject: string;
  window?: string | null;
  municipality: Municipality | null;
  stage: FamilyStage | null;
  householdNames: readonly string[];
}): ActivityDeidResult {
  const subject = gateFreeText(input.subject, input.householdNames);
  if (!subject.ok) {
    if (subject.refusal === 'empty') return { ok: false, refusal: 'empty_subject' };
    if (subject.refusal === 'too_long') return { ok: false, refusal: 'subject_too_long' };
    return { ok: false, refusal: 'names_a_person' };
  }

  // An ABSENT window is legal and a REFUSED one is not — different outcomes, kept apart
  // (rule #11). A window that scrubs away to nothing is ABSENT: a search with no season is
  // a real query, unlike a subject that scrubs to nothing, which is no query at all.
  const rawWindow = input.window?.trim() ?? '';
  let window: string | null = null;
  if (rawWindow !== '') {
    const gated = gateFreeText(rawWindow, input.householdNames);
    if (!gated.ok && gated.refusal === 'too_long') return { ok: false, refusal: 'window_too_long' };
    if (!gated.ok && gated.refusal === 'names_a_person') {
      return { ok: false, refusal: 'names_a_person' };
    }
    window = gated.ok ? gated.value : null;
  }

  return {
    ok: true,
    query: {
      subject: subject.value,
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
      return `That subject is longer than ${MAX_QUERY_FIELD_CHARS} characters. Call find_activities again with a short phrase for the activity itself, not the parent's whole message.`;
    case 'window_too_long':
      return `That window is longer than ${MAX_QUERY_FIELD_CHARS} characters. Call find_activities again with the season or the time of week in a few words, not the parent's whole message.`;
    case 'names_a_person':
      return 'That subject names somebody in the family, and a name never goes to a search. Call find_activities again with the activity alone - the age band travels with it already.';
  }
}
