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
