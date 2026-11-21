import { isEnabled } from '@hale/flags';
import { linqGroupOnboardingV2Enabled } from '~/lib/channel/linq/config';
import { linqGroupTurnAiEnabled } from '~/lib/channel/linq/group-turn-reader';

/**
 * VIL-448 (T26) — "remind me" from anyone in a family group. Exactly `true` turns it on;
 * anything else is off (the default).
 *
 * It only ever reads a turn the model has already judged to be Hale's
 * (`LINQ_GROUP_TURN_AI_ENABLED`) in a v2 group (`LINQ_GROUP_ONBOARDING_V2_ENABLED`), so no
 * word list decides whether a message is a reminder ask. Lighting order: v2, then the AI
 * turn reader, then this.
 */
export function groupRemindersEnabled(): boolean {
  return isEnabled('linq-group-reminders');
}

/**
 * VIL-707. An in-flight group reminder that Linq has not accepted yet can be
 * cancelled, and the send checks the member's opt-out again immediately before
 * the provider call. Exactly `true`. Anything else leaves `in_flight` to land.
 */
export const GROUP_REMINDER_INFLIGHT_CANCEL_ENV = 'GROUP_REMINDER_INFLIGHT_CANCEL_ENABLED';

export function groupReminderInFlightCancelEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('group-reminder-inflight-cancel', undefined, env);
}

/**
 * All three flags. The tick sends nothing unless this holds: with v2 off, a claimed group
 * is every loop text's home channel, so a reminder handed to the 1:1 dispatch could land
 * in the group instead.
 */
export function groupRemindersLive(): boolean {
  return groupRemindersEnabled() && linqGroupTurnAiEnabled() && linqGroupOnboardingV2Enabled();
}
