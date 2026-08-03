import { Bell, CircleCheck, CircleX, Clock, Shield, Sparkles, type LucideIcon } from 'lucide-react';
import type { MessageView } from '~/lib/messages/mappers';
import type { ChipTone } from '~/components/ui/tint-chip';

/**
 * The mark a note wears in the Messages list — a straight port of apps/mobile's
 * `messageChip` (src/app/(details)/notifications.tsx), reading the SAME `MessageView`
 * shape, so a note is marked identically on both surfaces.
 *
 * The mapping is SEMANTIC, never derived from the note's text: privacy first (a
 * redacted note is a redacted note whatever its lifecycle), then Hale's own brief,
 * then the action lifecycle. Meaning is the glyph plus the note's label beside it —
 * the tone is reinforcement, and a chip is aria-hidden.
 */
export function messageChip(message: MessageView): { as: LucideIcon; tone: ChipTone } {
  if (message.teenRedacted) return { as: Shield, tone: 'red' };
  if (message.kind === 'digest') return { as: Sparkles, tone: 'blue' };
  switch (message.actionState) {
    case 'autonomous':
      return { as: CircleCheck, tone: 'green' };
    case 'needs_human':
      return { as: Bell, tone: 'yellow' };
    case 'reverted':
      return { as: CircleX, tone: 'gray' };
    default:
      return { as: Clock, tone: 'yellow' };
  }
}
