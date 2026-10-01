/**
 * VIL-392 — the pull path.
 *
 * "set me up" / "what can you do" (and the French twins) ask for the ladder.
 * Bare HELP / INFO / AIDE stay on the keyword path and never arrive here.
 * One step per reply. Place and ages reuse the locked first-touch lines and
 * are not optional asks. Later steps stay placeholders and do not leave.
 */

import type { ReplyLanguage } from '~/lib/channel/language';
import {
  FIRST_TOUCH_AGES_BY_LANGUAGE,
  FIRST_TOUCH_IMESSAGE_BY_LANGUAGE,
  FIRST_TOUCH_SMS_BY_LANGUAGE,
} from '../copy';
import { whatCanYouDo } from './copy';
import type { ColdStartIntent } from './intent';

export type PullKind = 'place' | 'ages' | 'what' | 'later';

export function planPull(input: {
  intent: ColdStartIntent;
  language: ReplyLanguage;
  hasPlace: boolean;
  hasAges: boolean;
  channel: 'sms' | 'imessage';
  group: boolean;
  count: number;
  place: string;
  ages: string;
}): { kind: PullKind; body: string; mayLeave: boolean; skipped?: 'not_pull' | 'copy_unlocked' } {
  if (input.intent === 'what_can_you_do') {
    const answer = whatCanYouDo({
      language: input.language,
      count: input.count,
      place: input.place,
      ages: input.ages,
    });
    return { kind: 'what', body: answer.body, mayLeave: true };
  }
  if (input.intent !== 'set_me_up') {
    return { kind: 'later', body: '', mayLeave: false, skipped: 'not_pull' };
  }
  if (!input.hasPlace) {
    const card = input.channel === 'imessage' && !input.group;
    const body = card
      ? FIRST_TOUCH_IMESSAGE_BY_LANGUAGE[input.language]
      : FIRST_TOUCH_SMS_BY_LANGUAGE[input.language];
    return { kind: 'place', body, mayLeave: true };
  }
  if (!input.hasAges) {
    return { kind: 'ages', body: FIRST_TOUCH_AGES_BY_LANGUAGE[input.language], mayLeave: true };
  }
  return { kind: 'later', body: 'TODO-Design', mayLeave: false, skipped: 'copy_unlocked' };
}
