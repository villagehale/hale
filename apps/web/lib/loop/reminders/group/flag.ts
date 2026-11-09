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
  return process.env.LINQ_GROUP_REMINDERS_ENABLED?.trim() === 'true';
}

/**
 * All three flags. The tick sends nothing unless this holds: with v2 off, a claimed group
 * is every loop text's home channel, so a reminder handed to the 1:1 dispatch could land
 * in the group instead.
 */
export function groupRemindersLive(): boolean {
  return groupRemindersEnabled() && linqGroupTurnAiEnabled() && linqGroupOnboardingV2Enabled();
}
