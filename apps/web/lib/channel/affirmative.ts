/**
 * VIL-260 · WS4 — what a parent's YES and NO look like on this channel, in ONE place.
 *
 * Four modules used to hold private copies of this: C1's approval grammar (eleven exact
 * words), M6's caregiver confirmation (nine), M10's party-link confirm (twelve) and M8's
 * booking ask (six). They drifted, and every word missing from a copy was a parent whose
 * answer was silently dropped — a confirmed change that never happened, an invite that
 * lapsed because "yes please" was not on one list, a party link never made. There is one
 * table now, and widening it widens every reading at once (VIL-260 · WS4, VIL-265).
 *
 * The two properties that make a closed vocabulary safe are kept exactly as C1 wrote
 * them, because they are what stop consent being inferred (rule #4):
 *
 *   WHOLE-STRING. Never a substring search. "sounds good but can we do Thursday" is a
 *   question with an affirmative head, and claiming it would execute a calendar write
 *   while the thing the parent actually asked went unanswered. A body either IS one of
 *   these phrases or it is conversation, and there is no middle verdict.
 *
 *   VOCABULARY, NOT AUTHORITY. This module says what an affirmative IS. Whether one is
 *   allowed to DO anything is the caller's question — the approval handler still claims a
 *   bare affirmative only when an action is actually drafted, and M6 still requires a
 *   pending invite. Widening the words cannot widen either.
 *
 * The phrases are drawn from the sets the repo already shipped (party/reply.ts's
 * `do it`/`make it`, health/reply.ts's checkmarks) plus the ones the VIL-260 audit found
 * real parents sending, rather than invented here.
 */

/** The affirmative family. Multi-word entries are matched whole, like the single words. */
const AFFIRMATIVE = new Set([
  'yes',
  'y',
  'yeah',
  'yep',
  'yup',
  'ok',
  'okay',
  'k',
  'sure',
  'confirm',
  'confirmed',
  'approve',
  'approved',
  'do it',
  'do that',
  'yes do it',
  'go ahead',
  'go for it',
  'lets do it',
  'make it',
  'sounds good',
  'sounds great',
  'looks good',
  'that works',
  'works for me',
]);

/**
 * The refusal family. 'cancel' is NOT here, and never may be: it is a natural English
 * refusal AND a carrier-recognised STOP synonym, so a NO set containing it would turn an
 * unsubscribe into an approval decline. The CASL matcher is consulted before this one for
 * the same reason.
 */
const NEGATIVE = new Set([
  'no',
  'n',
  'nope',
  'nah',
  'skip',
  'never mind',
  'nevermind',
  'dont',
]);

/**
 * The reactions a phone keyboard sends fastest, mapped to the word they stand for.
 *
 * These MUST be translated before punctuation is stripped: the normalizer erases every
 * non-alphanumeric character, so a thumbs-up used to normalize to the empty string and
 * match nothing at all — the commonest confirmation on the whole surface, read as
 * silence. Skin-tone modifiers and the variation selector are dropped separately, so one
 * entry covers all six renderings of each.
 */
const EMOJI_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u{1F44D}\u{1F44C}\u{2705}\u{2714}\u{2611}\u{2713}]/gu, 'yes'],
  [/[\u{1F44E}\u{274C}\u{1F6AB}]/gu, 'no'],
];

/** Skin-tone modifiers and the emoji/text variation selectors — presentation, not
 * meaning, and they sit between the glyph and the matcher above. An alternation rather
 * than a character class: a class containing a skin-tone range reads as an attempt to
 * match the modified emoji itself, which is the opposite of stripping it. */
const EMOJI_MODIFIERS =
  /\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF}|\u{FE0E}|\u{FE0F}|\u{200D}/gu;

/** Words that carry no instruction and are stripped from either end before matching, so
 * "yes please" and "no thanks" stay the commands they obviously are. */
const FILLER = new Set(['please', 'pls', 'thanks', 'thank', 'you', 'thx']);

/**
 * A body reduced to the phrase it IS: emoji translated, apostrophes closed up so
 * "let's" reads as "lets", every other symbol dropped, filler trimmed off both ends, and
 * an immediately repeated word collapsed ("👍👍", "ok ok" — a phone keyboard's emphasis,
 * not a different message).
 *
 * Digits survive untouched and are never collapsed: the ordinal in "yes 2" is the
 * difference between two drafted actions.
 */
export function normalizeReply(body: string): string {
  let text = body.toLowerCase().replace(EMOJI_MODIFIERS, '');
  for (const [pattern, word] of EMOJI_WORDS) {
    text = text.replace(pattern, ` ${word} `);
  }
  const words = text
    .replace(/['’ʼ`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  return collapseRepeats(stripFiller(words)).join(' ');
}

function stripFiller(words: string[]): string[] {
  let start = 0;
  let end = words.length;
  while (start < end && FILLER.has(words[start] as string)) start += 1;
  while (end > start && FILLER.has(words[end - 1] as string)) end -= 1;
  return words.slice(start, end);
}

function collapseRepeats(words: string[]): string[] {
  return words.filter(
    (word, i) => i === 0 || word !== words[i - 1] || /\d/.test(word),
  );
}

export type Affirmation = 'yes' | 'no' | 'unclear';

/** What this body IS. `unclear` is the honest majority answer — it means the caller
 * must ask, or hand the message to something that can read it. */
export function readAffirmative(body: string): Affirmation {
  return matchPhrase(normalizeReply(body));
}

/** The same verdict for a phrase that has ALREADY been normalized — the approval
 * grammar splits its ordinal off first, so it cannot go through {@link readAffirmative}. */
export function matchPhrase(phrase: string): Affirmation {
  if (AFFIRMATIVE.has(phrase)) return 'yes';
  if (NEGATIVE.has(phrase)) return 'no';
  return 'unclear';
}
