/**
 * VIL-237 · M2 — the CASL keyword guards, which run BEFORE any model call.
 *
 * STOP is a legal instruction, not a message to be interpreted. Routing it through
 * an LLM would make unsubscribing probabilistic — a bad day for the model is a CASL
 * violation and a parent who asked to be left alone and wasn't. So the keywords are
 * matched deterministically here, first, every time; the model never sees them.
 *
 * Matching is EXACT on the normalized body (trimmed, case-folded, surrounding
 * punctuation stripped) — deliberately not a substring search. "Please stop sending
 * me swim class times" is a sentence about swimming, not an unsubscribe, and treating
 * it as one would silently drop a family who was still talking to us. A parent who
 * means STOP sends STOP; that is the convention carriers train them on.
 */

export type IntakeKeyword = 'stop' | 'help' | 'start';

const STOP_WORDS = new Set(['stop', 'unsubscribe', 'end', 'quit', 'cancel']);
const HELP_WORDS = new Set(['help', 'info']);
const START_WORDS = new Set(['start']);

/** Case-fold, trim, and drop surrounding punctuation/whitespace ("STOP." → "stop"). */
export function normalizeKeyword(body: string): string {
  return body
    .trim()
    .toLowerCase()
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '');
}

/** The CASL keyword this body IS, or null when it is ordinary conversation. */
export function matchKeyword(body: string): IntakeKeyword | null {
  const word = normalizeKeyword(body);
  if (STOP_WORDS.has(word)) return 'stop';
  if (HELP_WORDS.has(word)) return 'help';
  if (START_WORDS.has(word)) return 'start';
  return null;
}
