import type { Skill } from '@hale/agent';

/**
 * A nearby-find ask, in the parent's words. A calendar edit or a read of their
 * own calendar is not one, even when it names a weekend.
 */
const CALENDAR_EDIT = /\b(?:move|cancel|reschedul\w*|remind)\b/i;
const CALENDAR_READ = /\bwhat(?:['’]?s| is) on the calendar\b/i;
const FIND_ASK =
  /\b(?:what(?:['’]?s| is) on|what(?:['’]?s| is) (?:happening|going on|good)|anything (?:on|going on|happening)|who(?:['’]?s| is) around|things to do|what (?:can|should) we do|find (?:something|activities|a class|classes|us)|near(?:by| us| me)|trick[- ]or[- ]treat|drop[- ]ins?|halloween|(?:this|next|the) weekend)\b/i;

/**
 * The aside the parent must not hear: a comment on the search, the ranking, or
 * the result set. The preview leak was "All three finds share one page".
 */
const FIND_REASONING =
  /\b(?:all (?:two|three|four|five|2|3|4|5) finds?|all (?:two|three|four|five|2|3|4|5) share|share(?:s|d)? (?:one|a|the same) page|based on (?:my|the) search|i(?:'m| am) ranking|i ranked|from (?:my|the) search|(?:my|the) ranking|what i (?:checked|weighed)|how many came back|results? (?:came|come) back)\b/i;

function isNearbyFindAsk(body: string): boolean {
  if (CALENDAR_EDIT.test(body) || CALENDAR_READ.test(body)) return false;
  return FIND_ASK.test(body);
}

function priorUserText(
  body: string,
  transcript: readonly { role: string; content: string }[],
): string | null {
  const users = transcript
    .filter((message) => message.role === 'user')
    .map((message) => message.content.trim());
  if (users.length > 0 && users[users.length - 1] === body.trim()) users.pop();
  return users[users.length - 1] ?? null;
}

/**
 * True on the find ask itself, and on the next turn while that ask is still the
 * last thing they asked. A calendar edit ends it.
 */
export function nearbyFindTurn(
  body: string,
  transcript: readonly { role: string; content: string }[],
): boolean {
  if (isNearbyFindAsk(body)) return true;
  if (CALENDAR_EDIT.test(body)) return false;
  const prior = priorUserText(body, transcript);
  return prior !== null && isNearbyFindAsk(prior);
}

export function narratesFindReasoning(sentence: string): boolean {
  return FIND_REASONING.test(sentence);
}

/**
 * Same sentence grammar as the reconcile cutter: a break is punctuation or a
 * newline followed by a capital, so "10 a.m." stays one sentence.
 */
function sentencesOf(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+(?=[A-Z(])|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * The reply with reasoning sentences removed. A clean reply comes back as the
 * same string. An empty `text` means every sentence was an aside.
 */
export function withoutFindReasoning(body: string): { text: string; cut: number } {
  const sentences = sentencesOf(body);
  const kept = sentences.filter((sentence) => !narratesFindReasoning(sentence));
  const cut = sentences.length - kept.length;
  if (cut === 0) return { text: body, cut: 0 };
  return { text: kept.join(' ').replace(/\s+/g, ' ').trim(), cut };
}

/** `null` returns the same skill object, so a non-find turn's prompt is unchanged. */
export function augmentCoachSkillForFindPrivate(skill: Skill, addendum: Skill | null): Skill {
  if (addendum === null) return skill;
  return {
    ...skill,
    instructions: `${skill.instructions}\n\n${addendum.instructions}`,
  };
}
