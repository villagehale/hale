import { Calendar, FileText, Mail, ShoppingBag, Sparkles, type LucideIcon } from 'lucide-react';
import type { ChipTone } from '~/components/ui/tint-chip';

/**
 * The glyph + tint an action wears wherever it is shown as a chip — the approvals
 * queue, the coach's inline approval card. Chosen from the action's FAMILY so the
 * proposal reads at a glance (a calendar for a schedule change, an envelope for an
 * email); an unknown type falls back to the neutral Hale spark rather than guessing
 * a wrong glyph. Reads ONLY the action-type token (rule #1: never the payload).
 *
 * The tone pairings are Shore's own ad-hoc ones (`calendar` + blue = a scheduled
 * thing, `file-text` + gray = a document, `sparkles` + blue = Hale's own note).
 * They are decoration: meaning is carried by the glyph and the action label beside
 * it, never by the tone (DESIGN.md §Tint chips).
 */
export function actionGlyph(actionType: string): { icon: LucideIcon; tone: ChipTone } {
  if (actionType.includes('calendar') || actionType.includes('clinic'))
    return { icon: Calendar, tone: 'blue' };
  if (actionType.includes('email')) return { icon: Mail, tone: 'teal' };
  if (actionType.includes('order')) return { icon: ShoppingBag, tone: 'yellow' };
  if (actionType.includes('form') || actionType.includes('digest') || actionType.includes('routine'))
    return { icon: FileText, tone: 'gray' };
  return { icon: Sparkles, tone: 'blue' };
}
