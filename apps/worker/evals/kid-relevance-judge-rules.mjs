// The verdict rules the kid-relevance grader quotes from the kid-item-classifier skill.
//
// The grader scores a reason against the rules the classifier was given. A hand-written
// copy of those rules in the grader fell behind the skill three times, each time failing
// a reason that leaned on a rule the copy did not carry, so the grader reads them from
// the skill instead. Only the verdict rules are quoted: the grader's prompt is paid on
// every draw, and it grades neither the input list nor the output format.

/** The skill's kid list through its names, nicknames and ages paragraph. */
const VERDICTS_FROM = 'An item is about the kids (`kid`) when it is one of:';
const VERDICTS_UNTIL = 'Read the text in whatever language it is written in.';
/** The quoted-content paragraph and the notMineHints sentence. */
const QUOTED_FROM = "Every item's `text` is quoted from";
const QUOTED_UNTIL = 'For every item, return one entry:';

/**
 * The skill's verdict rules, as written. Throws when an anchor sentence is gone or out of
 * order: a reworded skill must fail the eval, never grade against an empty rule section.
 */
export function verdictRulesOf(skillInstructions) {
  let from = 0;
  const [verdictsFrom, verdictsUntil, quotedFrom, quotedUntil] = [
    VERDICTS_FROM,
    VERDICTS_UNTIL,
    QUOTED_FROM,
    QUOTED_UNTIL,
  ].map((anchor) => {
    if (!skillInstructions.includes(anchor)) {
      throw new Error(`kid-item-classifier skill: anchor not found: ${JSON.stringify(anchor)}`);
    }
    const at = skillInstructions.indexOf(anchor, from);
    if (at === -1) {
      throw new Error(`kid-item-classifier skill: anchor out of order: ${JSON.stringify(anchor)}`);
    }
    from = at + anchor.length;
    return at;
  });
  return [
    skillInstructions.slice(verdictsFrom, verdictsUntil).trim(),
    skillInstructions.slice(quotedFrom, quotedUntil).trim(),
  ].join('\n\n');
}
