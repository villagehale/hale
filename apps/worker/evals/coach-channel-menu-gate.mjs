/**
 * THE MENU GATE (VIL-295) — the refusal shape the corpus could not see.
 *
 * The skill has forbidden this since the boundary section was written, in these words:
 *
 *   > Grocery ordering is past what I can do - I handle the family schedule,
 *   > parenting questions, and finding activities. Anything on that side?
 *
 * and the capability table repeats it as the first of "the two shapes that are always
 * wrong". Nothing graded it. So when the verifier deleted the errands CANNOT row to see
 * whether the table was load-bearing, the coach answered
 *
 *   > Ordering groceries is past me - I handle the family schedule, activities, and
 *   > parenting questions.
 *
 * and the fixture PASSED at voice=4. The mutation had changed the answer into the exact
 * shape the prompt forbids, and the eval reported the row as decorative — the gate's
 * blindness is what made a real dependency look like a dead one.
 *
 * WHY A LIST IS THE FAILURE AND NOT JUST INELEGANT. A parent asked for one thing. The
 * list is Hale talking about itself instead of about them, it is the longest possible
 * way to say no, and it reads as a product apologising for its own scope. One clause for
 * the no, one for the adjacent can, then stop.
 *
 * NOT KEYED ON THE REFUSAL. An earlier draft only looked at replies that already carried
 * a refusal marker, and the good answer here ("Ordering groceries is past what I can do.")
 * matches none of them — so the gate would have depended on catching the refusal to catch
 * the menu, and missed any menu attached to a phrasing the marker list had not met yet.
 * Hale listing its own feature set is wrong in every reply, so the check is unconditional.
 */

/**
 * The ways a reply starts talking about its own scope. Each is first-person and
 * generic — a sentence about what Hale IS rather than about the thing that was asked.
 */
const MENU_LEADS = [
  'i handle',
  'i can help with',
  'i help with',
  'i can do',
  'i deal with',
  'i take care of',
  'i look after',
  "i'm here for",
  'i am here for',
  'what i do is',
  'my job is',
];

/**
 * A list of three or more things. Two is not a menu — "I can move it or cancel it" is
 * Hale offering the parent the two doors that exist for the thing they actually asked
 * about, and forbidding that would push the model into vaguer answers. Three is where a
 * reply stops answering and starts reciting.
 */
function isEnumeration(tail) {
  const commas = (tail.match(/,/g) ?? []).length;
  if (commas >= 2) return true;
  // "the schedule, activities and parenting" — the Oxford comma is optional and its
  // absence must not be the thing that gets a menu past this.
  return commas === 1 && /,[^.!?]*\b(and|or)\b/.test(tail);
}

/**
 * The menu in a reply, as the offending clause, or null.
 *
 * Sentence-scoped: the lead and the list have to be the same breath. Across a sentence
 * boundary they are two ordinary statements, and joining them here would fail a reply
 * that says what it can do and then, separately, names a week with three things on it.
 */
export function menuShape(reply) {
  for (const sentence of reply.split(/(?<=[.!?])\s+/)) {
    const lower = sentence.toLowerCase();
    for (const lead of MENU_LEADS) {
      const at = lower.indexOf(lead);
      if (at === -1) continue;
      if (isEnumeration(lower.slice(at + lead.length))) return sentence.trim();
    }
  }
  return null;
}
