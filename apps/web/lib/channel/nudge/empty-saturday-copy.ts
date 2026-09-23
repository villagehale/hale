import { proactiveNudgeTemplateKey } from './shell';

/**
 * VIL-365 · Design-locked EN ask (byte-stable aside from the {kid} slot).
 *
 * `This Saturday looks open for {kid}. Want one nearby find that's actually running?`
 *
 * Design's typographic apostrophe (U+2019) is the GSM-7 apostrophe (U+0027) here.
 * One character outside the basic alphabet flips the whole SMS to UCS-2, and this
 * ask is measured as one segment with the full opt-out line on it.
 *
 * FR TODO: the ticket says a French twin is locked, but it was not in the repo
 * or in the Linear comments and design docs searched on 2026-09-23. Do not invent one.
 * Ship EN only until that twin is pasted in from Design.
 */
export function renderEmptySaturdayAsk(kid: string): string {
  return `This Saturday looks open for ${kid}. Want one nearby find that's actually running?`;
}

/** Ledger key the open-question reader recognises. Same string the sender stamps. */
export const EMPTY_SATURDAY_TEMPLATE_KEY = proactiveNudgeTemplateKey('empty_saturday');
