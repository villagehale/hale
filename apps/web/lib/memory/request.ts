import { type ReplyLanguage, acceptReplyLanguage } from '~/lib/channel/language';
import type { MeaningScreen } from '~/lib/channel/meaning-screen/read';

/**
 * VIL-723 — what a parent asked of what Hale remembers, read for its meaning.
 *
 * "What do you know about us?", "forget X" and "correct X" are read by the model on the
 * meaning screen (`memory_request`), in any wording and any language or script. There is
 * no phrase list behind it: the exact-phrase regexes that used to claim these turns are
 * gone. An unread screen claims nothing, so the coach still answers the text.
 *
 * Which remembered fact a forget or a correction means is a second read
 * (`memory_target`), over only the facts this parent may hear, by ref. Code never matches
 * the parent's words against a fact.
 */

export type MemoryRequestKind = 'list' | 'forget' | 'correct';

export interface MemoryRequest {
  kind: MemoryRequestKind;
  /** The parent's own words for what to forget or correct. Empty when they named nothing. */
  target: string;
  /** The corrected value, as the parent said it. Empty unless `kind` is `correct`. */
  value: string;
  /** The language the parent wrote in, as a tag, when the screen read one. */
  language: ReplyLanguage | null;
}

/** `unread`: the screen did not answer. Null: it answered, and this is not about memory. */
export async function readMemoryRequest(
  screen: MeaningScreen,
  body: string,
): Promise<MemoryRequest | null | 'unread'> {
  const text = body.trim();
  if (!text) return null;
  const reading = await screen.read({ screen: 'memory_request', text });
  if (!reading) return 'unread';
  if (reading.memory === 'none') return null;
  return {
    kind: reading.memory,
    target: reading.memory === 'list' ? '' : reading.target,
    value: reading.memory === 'correct' ? reading.value : '',
    language: acceptReplyLanguage(reading.language),
  };
}

/** One fact a forget or a correction may mean, as the target read is shown it. */
export interface MemoryTargetCandidate {
  /** A data line for the model: the key, the value and where it came from. Never parent copy. */
  line: string;
}

export interface MemoryTargetReading<T extends MemoryTargetCandidate> {
  /** The candidates the parent means, in the order the read named them. */
  chosen: T[];
  /** The corrected value, when the read gave one. */
  value: string;
  /** A snake_case key for a correction no candidate holds, when the read gave one. */
  key: string;
}

/**
 * Which of `candidates` the parent means. Candidates are shown newest first, each with a
 * ref (`f1`, `f2`, ...) that only this call knows; a ref the read names that is not one
 * of them is dropped. `unread`: the screen did not answer, and nothing may be acted on.
 */
export async function readMemoryTargets<T extends MemoryTargetCandidate>(
  screen: MeaningScreen,
  body: string,
  candidates: readonly T[],
): Promise<MemoryTargetReading<T> | 'unread'> {
  const byRef = new Map<string, T>();
  const facts = candidates.map((candidate, index) => {
    const ref = `f${index + 1}`;
    byRef.set(ref, candidate);
    return `${ref}: ${candidate.line}`;
  });
  const reading = await screen.read({ screen: 'memory_target', text: body.trim(), facts });
  if (!reading) return 'unread';
  const chosen: T[] = [];
  for (const ref of reading.refs) {
    const candidate = byRef.get(ref);
    if (candidate && !chosen.includes(candidate)) chosen.push(candidate);
  }
  return { chosen, value: reading.value, key: reading.key };
}
