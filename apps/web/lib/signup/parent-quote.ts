/** Case, width and spacing aside: what a copied quote is compared on. */
export function foldWords(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** True when `quote` is the parent's own words, copied. A model cannot invent a quote. */
export function quotesParent(parentWords: string, quote: string | null): boolean {
  if (quote === null) return false;
  const q = foldWords(quote);
  return q.length > 0 && foldWords(parentWords).includes(q);
}

const WORD = /[\p{L}\p{N}]+/gu;
/** Scripts written without spaces between words: one run of them can be a whole clause. */
const UNSPACED =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+$/u;
const MIN_UNSPACED_CLAUSE = 4;
/** Shorter words of a name (`a`, `of`, `de`) name nothing on their own. */
const MIN_NAME_WORD = 3;

/**
 * True when `quote` says more than one word: two different words, or one run of four
 * different characters in a script written without spaces. A bare ok, yes or 好的 is not a
 * clause. Shape only: what the words mean is the model's to read.
 */
export function isClause(quote: string | null): boolean {
  if (quote === null) return false;
  const words = new Set(foldWords(quote).match(WORD) ?? []);
  if (words.size >= 2) return true;
  const [only] = words;
  return only !== undefined && UNSPACED.test(only) && new Set(only).size >= MIN_UNSPACED_CLAUSE;
}

/**
 * True when `words` carry a word of the program's public name or of its site's host (the
 * top-level domain aside). `activity` is untrusted page text: clean it before it gets here.
 */
export function namesFacts(
  words: string,
  facts: { activity: string | null; host: string },
): boolean {
  const site = facts.host.split('.').slice(0, -1).join(' ');
  const names = foldWords(`${facts.activity ?? ''} ${site}`).match(WORD) ?? [];
  const folded = foldWords(words);
  return names.some((name) => [...name].length >= MIN_NAME_WORD && folded.includes(name));
}
