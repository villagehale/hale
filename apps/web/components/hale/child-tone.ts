import type { ChipTone } from '~/components/ui/tint-chip';

/**
 * The stable tint a child's scope tag wears across the receipts path, so a
 * two-kid family can scan "whose is this" down a week of plan lanes without
 * reading every name.
 *
 * DEVIATION, named for review: apps/mobile has no per-child tint — every child
 * there is the same ink disc / blue chip. The one index-cycled tint in the whole
 * app is `attachmentTone(index)` (apps/mobile/src/lib/ask-attachments.ts), which
 * cycles four tones; this mirrors that idiom, keyed on the child's id instead of
 * a position so the same child keeps the same tone on every surface and across
 * sessions. Reverting is one line: return `'gray'` unconditionally.
 *
 * `red` is excluded from the rotation — Shore already spends it on privacy /
 * redaction (`shield` + red is the teen-redaction mark), and a child whose tag
 * read in the privacy tone would be actively misleading. `gray` is excluded too:
 * it is what "not one particular child" means (whole family, a shared outing, a
 * group whose members disagree). So a tint here always means "exactly this kid".
 *
 * The tone is never the carrier: the tag always shows the (teen-safe) name, so a
 * collision between two children in a 5+ kid family costs a reader nothing.
 */
const CHILD_TONES = ['blue', 'green', 'yellow', 'teal'] as const satisfies readonly ChipTone[];

/** FNV-1a over the id's code units — a small, stable, dependency-free spread.
 * `>>> 0` keeps it unsigned so the modulo can't go negative. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The tone for a scope tag. `null` — the whole family — and any composite scope
 * (an outing two kids share) take the neutral gray, so a tint always names one
 * child. Callers pass a single child id or nothing.
 */
export function childTone(childId: string | null): ChipTone {
  if (childId === null) return 'gray';
  return CHILD_TONES[hash(childId) % CHILD_TONES.length] as ChipTone;
}
