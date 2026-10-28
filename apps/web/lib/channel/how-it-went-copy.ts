import type { ReplyLanguage } from '~/lib/channel/language';
import { speak } from '~/lib/channel/spoken-line';

/**
 * How an activity went. The model writes the ask. There is no fixed sentence.
 */
export function howItWentAsk(
  activity: string,
  language: ReplyLanguage | null = 'en',
): Promise<string | null> {
  return speak({ purpose: 'how_it_went', language, facts: { activity } });
}
