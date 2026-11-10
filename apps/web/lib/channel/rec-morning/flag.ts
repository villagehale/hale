/**
 * VIL-545 leftover · the model picks which rec-morning facts answer a parent's text.
 * Off unless REC_MORNING_MODEL_TOPIC_ENABLED is exactly `true`: `true\n` (a piped
 * `echo` into `vercel env add`), `TRUE`, `1` and `on` stay off. Default off: the
 * word test in match.ts still picks the facts, and rec-morning-read still decides
 * whether the lane speaks. On, the word test is not consulted; a Haiku screen
 * picks a topic from the family's catalog, or none.
 */
export const REC_MORNING_MODEL_TOPIC_ENABLED_ENV = 'REC_MORNING_MODEL_TOPIC_ENABLED';

export function recMorningModelTopicEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[REC_MORNING_MODEL_TOPIC_ENABLED_ENV] === 'true';
}
