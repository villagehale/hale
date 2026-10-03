/**
 * VIL-413 — friend-voice onboarding.
 *
 * Off unless ONBOARDING_FRIEND_VOICE_ENABLED is exactly `on` after trim.
 * `true`, `1`, and `ON` stay off. Unset stays off, which is today's copy.
 */
export const ONBOARDING_FRIEND_VOICE_ENABLED_ENV = 'ONBOARDING_FRIEND_VOICE_ENABLED';

export function onboardingFriendVoiceEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env[ONBOARDING_FRIEND_VOICE_ENABLED_ENV] ?? '').trim() === 'on';
}
