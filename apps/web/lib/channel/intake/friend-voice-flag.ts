/**
 * VIL-541 leftover: remaining friend-voice decisions that still match '?' or
 * English/French words (a plain yes, a lone name, question counts, a name ask,
 * speaking as the parent, the join number in the prose).
 *
 * Off unless FRIEND_VOICE_LEFTOVER_MARKS_ENABLED is exactly `true`. A trailing
 * newline from `vercel env add` stays off. Unset stays off. Off keeps today's
 * regex path so existing recordings keep their keys.
 */

export const FRIEND_VOICE_LEFTOVER_MARKS_ENABLED_ENV = 'FRIEND_VOICE_LEFTOVER_MARKS_ENABLED';

export function friendVoiceLeftoverMarksEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[FRIEND_VOICE_LEFTOVER_MARKS_ENABLED_ENV] === 'true';
}
