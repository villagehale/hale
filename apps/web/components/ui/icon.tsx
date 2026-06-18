import type { LucideIcon } from 'lucide-react';

/**
 * Icon convention for the app: Lucide glyphs at 24px, 2px stroke. Pass any
 * Lucide icon as `as`; size/stroke default to the house style. Decorative by
 * default (aria-hidden) — the adjacent text or the parent control's aria-label
 * carries the meaning.
 */
export function Icon({
  as: Glyph,
  size = 24,
  strokeWidth = 2,
  className,
}: {
  as: LucideIcon;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return <Glyph size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />;
}
