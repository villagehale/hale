import type { ReplyLanguage } from '~/lib/channel/language';

/**
 * VIL-366 · Design-locked ask (byte-stable aside from the activity slot).
 *
 * EN: `How did {activity} go? One line is plenty.`
 * FR: `Comment ca s'est passe pour {activity} ? Une ligne suffit.`
 *
 * The French twin is the accent-free GSM-7 ASCII Sloane locked, with the space
 * before `?`. Callers that omit the language stay on English. These proactive
 * asks have no inbound message, and no existing caller selects a locale for them.
 */
const HOW_IT_WENT_ASK: Record<ReplyLanguage, (activity: string) => string> = {
  en: (activity) => `How did ${activity} go? One line is plenty.`,
  fr: (activity) => `Comment ca s'est passe pour ${activity} ? Une ligne suffit.`,
};

export function howItWentAsk(activity: string, language: ReplyLanguage = 'en'): string {
  return HOW_IT_WENT_ASK[language](activity);
}
