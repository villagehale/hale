import type { LucideIcon } from 'lucide-react';

/**
 * Hale Shore's tinted icon chip — the web half of
 * `apps/mobile/src/components/ui/tint-chip.tsx`: a 34×34 squircle (radius 11) in
 * one of six tone grounds, carrying a Lucide glyph in the paired icon hue.
 *
 * The geometry and the tone pairs live in globals.css (`.tint-chip`, `.chip-*`),
 * so both themes derive from the token layer. The glyph takes `currentColor` —
 * which the tone class sets — instead of a colour prop, which is the one place
 * the web version can be simpler than the native one.
 *
 * Tone NEVER carries the meaning (DESIGN.md §Tint chips): the glyph plus the
 * label beside the chip do. A chip is decorative to a screen reader.
 */
export type ChipTone = 'blue' | 'green' | 'yellow' | 'red' | 'teal' | 'gray';

/** Shore's icon stroke — 1.8px, hardcoded in the mobile Icon and not a prop
 * there either. The app-wide `~/components/ui/icon.tsx` default is still 2. */
const SHORE_STROKE = 1.8;

/** Half the chip, as the native component computes it (`round(size * 0.5)`). */
const GLYPH_SIZE = 17;

export function TintChip({ as: Glyph, tone }: { as: LucideIcon; tone: ChipTone }) {
  return (
    <span className={`tint-chip chip-${tone}`}>
      <Glyph size={GLYPH_SIZE} strokeWidth={SHORE_STROKE} aria-hidden="true" />
    </span>
  );
}
