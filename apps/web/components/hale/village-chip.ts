import {
  BookOpen,
  CalendarDays,
  Heart,
  Lock,
  Shield,
  Sparkles,
  Trees,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { ChipTone } from '~/components/ui/tint-chip';

/**
 * The mark a village row wears — the same `{glyph, tone}` vocabulary the receipts
 * path uses (`messageChip`), so a place on the board and a note in Messages are
 * marked by one system rather than two.
 *
 * The glyph maps the KIND (a class, a drop-in, a park), and the tone reinforces it.
 * Tone never carries the meaning (DESIGN.md §Tint chips) — the glyph and the row's
 * own "Activity · seasonal" line do — which is why an unknown kind can safely fall
 * back to the generic sparkles rather than guessing.
 *
 * `red` is reserved: it is the privacy mark across every surface, so it appears here
 * ONLY on a teen-attributed row (rule #1), never as a content tone. `gray` is the
 * curated-directory lane, which is a different kind of thing from the family's own
 * discovered picks and reads as the quieter one.
 */

const KIND_CHIP: Record<string, { as: LucideIcon; tone: ChipTone }> = {
  class: { as: Sparkles, tone: 'blue' },
  program: { as: CalendarDays, tone: 'blue' },
  drop_in: { as: Users, tone: 'green' },
  outdoor: { as: Trees, tone: 'green' },
  library: { as: BookOpen, tone: 'yellow' },
  community_event: { as: CalendarDays, tone: 'teal' },
};

const RESOURCE_CHIP: Record<string, LucideIcon> = {
  'EarlyON child & family centres': Users,
  "Public library children's programs": BookOpen,
  'Parks & splash pads': Trees,
  'Public health': Shield,
  'Community/recreation centres': Users,
};

/** A discovered activity's mark. A teen-attributed row leads with the PRIVACY mark
 * instead of its kind — what a parent needs to read first is that this one is held
 * back, the same lead the redacted rows on Approvals / Trail / Plan take. */
export function villageChip(
  kind: string,
  teenAttributed = false,
): { as: LucideIcon; tone: ChipTone } {
  if (teenAttributed) return { as: Lock, tone: 'red' };
  return KIND_CHIP[kind] ?? { as: Sparkles, tone: 'blue' };
}

/** A curated resource's mark. Unknown categories fall back to a neutral heart — a
 * verified-directory glyph, never a fabricated category. */
export function resourceChip(category: string): { as: LucideIcon; tone: ChipTone } {
  return { as: RESOURCE_CHIP[category] ?? Heart, tone: 'gray' };
}
