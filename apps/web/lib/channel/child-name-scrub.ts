/**
 * Takes the household's child names out of text that is about to cross the border to
 * Anthropic's US web_search (rule #1). The intake search paths are chosen by the model's
 * read in any language (VIL-555), so this has to hold in every alphabet a family writes.
 *
 * Not `\b`: JavaScript defines it on [A-Za-z0-9_], so 小明, Zoé and José went to the
 * search intact. A name is bounded by anything that is not a letter or a digit, and a
 * name in a script written without spaces (小明什么时候…) is removed wherever it appears.
 *
 * A name that survives the scrub in a looser form (Zoe for Zoé) is a refusal, not a
 * search: the caller does not search and names the outcome.
 */

export type ChildNameScrub = { ok: true; text: string } | { ok: false; refusal: 'names_a_child' };

const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function canonical(value: string): string {
  return value.normalize('NFKC').replace(/\p{Cf}/gu, '');
}

function folded(value: string): string {
  return canonical(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function nameMatcher(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return UNSPACED_SCRIPT.test(name)
    ? new RegExp(escaped, 'giu')
    : new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
}

function wantedNames(names: readonly string[]): string[] {
  return names.map((name) => canonical(name).trim()).filter((name) => name !== '');
}

/** True when `text` holds any of `names` in any form this file reads as that name: in any
 * alphabet, without its accents, in any case. */
export function namesAChild(text: string, names: readonly string[]): boolean {
  const residue = folded(text);
  return wantedNames(names).some((name) => nameMatcher(folded(name)).test(residue));
}

export function scrubChildNames(text: string, names: readonly string[]): ChildNameScrub {
  const wanted = wantedNames(names);
  let out = canonical(text);
  for (const name of wanted) out = out.replace(nameMatcher(name), '');
  if (namesAChild(out, wanted)) return { ok: false, refusal: 'names_a_child' };
  return { ok: true, text: out };
}
