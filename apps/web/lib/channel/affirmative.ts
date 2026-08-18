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
 *
 * IT NOW READS THREE LANGUAGES, because Hale already writes in three. The coach and the
 * general-answer path reply in French and Chinese, and this table did not — so Hale asked
 * a question in French and could not hear "oui", which is why its French copy still had to
 * spell the English token YES inside a French sentence to get an answer back at all.
 *
 * That was two defects wearing one coat, and the words are only half of it:
 *
 *   THE NORMALIZER ERASED CJK. Reducing a body to /[a-z0-9]/ turned every Chinese reply
 *   into the empty string, so "好" and an empty message were the same input. A Han
 *   character is a WORD here, not punctuation, and the class has to say so — putting 好 in
 *   the set below without that is a change that reads like a fix and does nothing.
 *
 *   THE NORMALIZER SPLIT ACCENTS. "bien sûr" came out "bien s r". Folding the diacritic
 *   before the class runs is what lets one entry cover both spellings a phone sends, and
 *   it is invisible to the English words, which have none.
 *
 * WHAT DID NOT COME ACROSS is as deliberate as what did. 'cancel' is barred from the NO set
 * below, and its translations are barred for the same reason — see that comment.
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
  // French, spelled as the normalizer leaves it: the apostrophe closes up ("d'accord" →
  // daccord), the hyphen opens out ("allons-y" → allons y), and the circumflex is folded.
  'oui',
  'ouais',
  'daccord',
  'cest bon',
  'parfait',
  'allons y',
  'vas y',
  'absolument',
  'certainement',
  'bien sur',
  // Chinese. Whole-string costs nothing to enforce in a script written without spaces —
  // a longer sentence beginning 好的 arrives as one token and is simply not this one.
  '好',
  '好的',
  '好啊',
  '可以',
  '行',
  '嗯',
  '是',
  '是的',
  '要',
  '确认',
  '没问题',
]);

/**
 * The refusal family. 'cancel' is NOT here, and never may be: it is a natural English
 * refusal AND a carrier-recognised STOP synonym, so a NO set containing it would turn an
 * unsubscribe into an approval decline. The CASL matcher is consulted before this one for
 * the same reason.
 *
 * NEITHER ARE ITS TRANSLATIONS — annule, annuler, arrête, 取消 — and the rule is stronger
 * for them, not weaker. `matchKeyword` holds the English STOP list only, so a French parent
 * texting "arrête" is not claimed upstream the way "stop" is; if this set claimed it, a
 * request to be left alone would be answered as a declined calendar change and the family
 * would keep hearing from us. Leaving them unread is not silence — an unmatched body goes
 * to the coach, which answers in the parent's language and can ask which they meant.
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
  // French.
  'non',
  'pas maintenant',
  'pas cette fois',
  // Chinese. 别 and 算了 are the twins of 'dont' and 'never mind' already above.
  '不',
  '不要',
  '不用',
  '不行',
  '别',
  '算了',
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
 * A body reduced to the phrase it IS: emoji translated, accents folded onto their base
 * letter, apostrophes closed up so "let's" reads as "lets", every other symbol dropped,
 * filler trimmed off both ends, and an immediately repeated word collapsed ("👍👍",
 * "ok ok" — a phone keyboard's emphasis, not a different message).
 *
 * WHAT SURVIVES THE SYMBOL SWEEP IS THE WHOLE DESIGN, and it is three things rather than
 * one, because two of them were missing and each cost a language:
 *
 *   Digits, never collapsed: the ordinal in "yes 2" is the difference between two drafted
 *   actions.
 *
 *   Han characters, because in Chinese the glyph IS the word. They were swept out with the
 *   punctuation, which is why every Chinese reply used to normalize to "" and read as
 *   silence. `Script=Han` is the precise class for this: it takes 好 and 不 and leaves
 *   ，。！？ to be swept as the separators they are, so the whole-string rule still holds.
 *
 *   Base letters under their accents. Decomposing first and dropping the combining marks
 *   turns "bien sûr" into "bien sur" instead of "bien s r" — one entry in the table above
 *   covers however a given phone spelled it, and English, having no marks, cannot notice.
 */
export function normalizeReply(body: string): string {
  let text = body.toLowerCase().replace(EMOJI_MODIFIERS, '');
  for (const [pattern, word] of EMOJI_WORDS) {
    text = text.replace(pattern, ` ${word} `);
  }
  const words = text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/['’ʼ`]/g, '')
    .replace(/[^a-z0-9\p{Script=Han}]+/gu, ' ')
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
