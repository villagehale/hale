import { recMorningReturnLine } from '~/lib/channel/rec-morning/copy';

const INTAKE_MAX_REPLY_CHARS = 300;

/**
 * VIL-323 Designer lock 2026-08-27 — English adult-learn door. A model does not write this.
 * Hyphens, not em dashes. Never "I don't do that."
 */
export const ADULT_LEARN_DOOR =
  "I'm a kids' rec helper, not adult lessons. If you've got kids, send their names and ages and I'll watch Brampton for them. If it's just you, no hard feelings.";

function fold(body: string): string {
  return body.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Adult learner / "I wanna learn swimming" / adult lessons.
 * Narrow on purpose: a city rec-morning clock stays rec-morning's job.
 */
export function isAdultLearnAsk(body: string): boolean {
  const text = fold(body);
  if (text === '') return false;
  if (/\badult\s+(?:swim(?:ming)?\s+)?lessons?\b/.test(text)) return true;
  if (/\badult\s+learn/.test(text)) return true;
  if (/\bi\s+(?:wanna|want to)\s+learn\b/.test(text) && /\bswim/.test(text)) return true;
  return false;
}

/**
 * Mid-signup / first-text: the locked kids-only door plus Hale's outstanding ask.
 * Cold start appends {@link recMorningReturnLine}'s COLD_START ask. Null when the
 * parent's text was not an adult-learn ask.
 */
export function adultLearnIntakeReply(input: {
  parentWords: string;
  pendingAsk: string;
}): string | null {
  if (!isAdultLearnAsk(input.parentWords)) return null;
  const joined = `${ADULT_LEARN_DOOR} ${recMorningReturnLine(input.pendingAsk)}`;
  if (joined.length > INTAKE_MAX_REPLY_CHARS) {
    throw new Error(
      `adult-learn intake reply is ${joined.length} chars, cap is ${INTAKE_MAX_REPLY_CHARS}`,
    );
  }
  return joined;
}
