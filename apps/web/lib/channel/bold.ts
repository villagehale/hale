import type { LinqTextDecoration } from '~/lib/channel/linq/transport';

/**
 * VIL-474 · the writer names the exact words it wants bold; code finds them. The
 * model never counts offsets. Words that are not in `text` mean nothing is bolded and
 * the writer's text goes out undecorated, exactly as written. One range at most, the
 * first match. Offsets are JS string indexes, which are the UTF-16 units Linq expects.
 */
export function boldDecorations(
  text: string,
  words: string | null | undefined,
): LinqTextDecoration[] | undefined {
  const target = words?.trim();
  if (!target) return undefined;
  const start = text.indexOf(target);
  if (start < 0) return undefined;
  return [{ range: [start, start + target.length], style: 'bold' }];
}

/** Which of `texts` carries the bold: the first one that contains the words, or -1. */
export function boldTextIndex(texts: readonly string[], words: string | null | undefined): number {
  const target = words?.trim();
  if (!target) return -1;
  return texts.findIndex((t) => t.includes(target));
}
