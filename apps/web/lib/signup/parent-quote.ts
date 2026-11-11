import { SHARED_SIGNUP_PLATFORMS } from './plan/towns';

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
/** A shorter word (`gym`, `art`, `the`, `anc`, `app`) is too common to name a program alone. */
const MIN_NAME_WORD = 4;

/** The whole words of `text`, folded, in order. */
function words(text: string): string[] {
  return foldWords(text).match(WORD) ?? [];
}

function isLongWord(word: string): boolean {
  return [...word].length >= MIN_NAME_WORD;
}

/** True when `text` and `other` have a whole word in common, of any length. */
export function sharesWord(text: string, other: string): boolean {
  const theirs = new Set(words(other));
  return words(text).some((word) => theirs.has(word));
}

/**
 * The labels of a registration site's host that name its provider. The top-level label
 * goes, then every label too short to name anything (`www`, `on` in `.on.ca`, `co`, `apm`);
 * the next label in is the registrable name. On a shared platform that name is the
 * platform's, so the provider is named by a subdomain instead (`cityofkingston` in
 * `cityofkingston.perfectmind.com`). Elsewhere a subdomain is a section of the provider's
 * own site (`register`, `booking`), and only the registrable name names it.
 */
function providerLabels(host: string): string[] {
  const labels = host.toLowerCase().split('.').filter(Boolean).slice(0, -1);
  const at = labels.findLastIndex(isLongWord);
  const registrable = labels[at];
  if (registrable === undefined) return [];
  return SHARED_SIGNUP_PLATFORMS.includes(registrable) ? labels.slice(0, at) : [registrable];
}

/** `run`'s words appear in `said` one after another, in order. */
function containsRun(said: readonly string[], run: readonly string[]): boolean {
  return said.some((_, start) => run.every((word, i) => said[start + i] === word));
}

/**
 * A name is named by one of its words of four letters or more, written whole. A name made
 * only of shorter words (`Art & Me`) is named by all of them, written in order.
 */
function nameWritten(name: readonly string[], said: readonly string[]): boolean {
  const long = name.filter(isLongWord);
  if (long.length > 0) return long.some((word) => said.includes(word));
  return name.length >= 2 && containsRun(said, name);
}

/**
 * True when `text` names the program by its public name, or its site's provider, in whole
 * words: never a fragment of a word (`anc` in cancel, `app` in happy), never the platform a
 * site is hosted on, never a section of a site (`register`). Shape only: what the words
 * mean is the model's to read. `activity` is untrusted page text: clean it before it gets
 * here.
 */
export function namesFacts(
  text: string,
  facts: { activity: string | null; host: string },
): boolean {
  const said = words(text);
  const names = [facts.activity ?? '', ...providerLabels(facts.host)].map(words);
  return names.some((name) => nameWritten(name, said));
}
