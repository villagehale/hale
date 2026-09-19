/**
 * VIL-353 · how this lane reads a parent's sentence when no model is allowed to.
 *
 * ONE FOLD, TWO SCREENS. Both deterministic screens in the evening lane decide by looking
 * for whole words: the privacy deny-list (notes.ts), which refuses to keep a sentence, and
 * the addressed-to-Hale screen (request.ts), which refuses to claim one. Folding the text
 * two different ways would leave one of them quietly weaker than the other on an accent,
 * a capital or a comma, so the fold lives in one place and both import it.
 */

/**
 * Lowercased, accent-folded, every run of non-alphanumerics reduced to a single space,
 * and a space at each end so a phrase lookup is always a WHOLE-word match: 'ok' must not
 * fire on 'smoked', and 'race' must not fire on 'braces'.
 */
export function foldWords(body: string): string {
  return ` ${body
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/** Whether the folded text contains this phrase as whole words. */
export function containsPhrase(folded: string, phrase: string): boolean {
  return folded.includes(` ${phrase} `);
}

/** Whether the folded text OPENS with this word. */
export function opensWith(folded: string, word: string): boolean {
  return folded.startsWith(` ${word} `);
}

/**
 * The plural of a screened phrase, derived rather than listed.
 *
 * A word list written in the singular is defeated by one letter — 'allergy' was screened
 * and 'allergies' was not — and the fix is not a longer list, which would be defeated by
 * the next word nobody thought of. Only the last word of a phrase inflects ('emergency
 * room' -> 'emergency rooms'), and a phrase already plural simply produces a form that
 * never matches anything.
 */
export function pluralOf(phrase: string): string {
  const words = phrase.split(' ');
  const last = words[words.length - 1] as string;
  words[words.length - 1] = pluralWord(last);
  return words.join(' ');
}

function pluralWord(word: string): string {
  if (word.endsWith('is')) return `${word.slice(0, -2)}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}
