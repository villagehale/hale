/** Letters written with no space between words: a name there is a run inside a longer one. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const WORD = /[\p{L}\p{N}]+/gu;

function words(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().match(WORD) ?? [];
}

/** `term`'s words appear in `said`, whole and in order. */
function saysWholeWords(said: readonly string[], term: readonly string[]): boolean {
  if (term.length === 0) return false;
  return said.some((_, start) => term.every((word, i) => said[start + i] === word));
}

/** `line` says `term` in whole words, in order (a script without spaces: as a run). */
export function saidAsWholeWords(line: string, term: string): boolean {
  const needle = term.normalize('NFKC').trim().toLowerCase();
  if (!needle) return false;
  if (UNSPACED.test(needle)) return line.normalize('NFKC').toLowerCase().includes(needle);
  return saysWholeWords(words(line), words(needle));
}

/**
 * Whether a group line repeats a string from the chat's deny list (the private terms of
 * every household in it, built by `denyListForChat`). These are the facts Hale already
 * holds, not a word list of intents. A term matches as whole words, so `Ava` never
 * silences "Available"; a term in a script written without spaces matches inside a run,
 * so a name there is never missed (fails closed).
 */
export function groupLineLeaksPrivate(line: string, deny: readonly string[]): boolean {
  const said = words(line);
  const folded = line.normalize('NFKC').toLowerCase();
  for (const token of deny) {
    const needle = token.normalize('NFKC').trim().toLowerCase();
    if (needle.length < 3) continue;
    if (UNSPACED.test(needle) ? folded.includes(needle) : saysWholeWords(said, words(needle))) {
      return true;
    }
  }
  return false;
}
