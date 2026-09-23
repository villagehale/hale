import type { ReplyLanguage } from '~/lib/channel/language';
import { proactiveNudgeTemplateKey } from './shell';

/**
 * VIL-365 · Design-locked ask (byte-stable aside from the {kid} slot).
 *
 * EN: `This Saturday looks open for {kid}. Want one nearby find that's actually running?`
 * FR: `Ce samedi a l'air libre pour {kid}. Tu veux une seule idee a cote qui tourne vraiment ?`
 *
 * Design's typographic apostrophe (U+2019) is the GSM-7 apostrophe (U+0027) on the
 * English line. The French twin is the accent-free GSM-7 ASCII Sloane locked, with
 * the space before `?`. One character outside the basic alphabet flips the whole
 * SMS to UCS-2, and this ask is measured as one segment with the full opt-out line.
 *
 * Callers that omit the language stay on English. These proactive asks have no
 * inbound message, and no existing caller selects a locale for them.
 */
const EMPTY_SATURDAY_ASK: Record<ReplyLanguage, (kid: string) => string> = {
  en: (kid) => `This Saturday looks open for ${kid}. Want one nearby find that's actually running?`,
  fr: (kid) =>
    `Ce samedi a l'air libre pour ${kid}. Tu veux une seule idee a cote qui tourne vraiment ?`,
};

export function renderEmptySaturdayAsk(kid: string, language: ReplyLanguage = 'en'): string {
  return EMPTY_SATURDAY_ASK[language](kid);
}

/** Ledger key the open-question reader recognises. Same string the sender stamps. */
export const EMPTY_SATURDAY_TEMPLATE_KEY = proactiveNudgeTemplateKey('empty_saturday');
