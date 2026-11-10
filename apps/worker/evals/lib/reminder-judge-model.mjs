/**
 * The reminder eval's judge: the shared judge's model (agent.SONNET_MODEL, as #919/#922
 * grade with), unless REMINDER_JUDGE_MODEL names another for a comparison run.
 * The id is read from packages/agent, never pinned here.
 */
export function reminderJudgeModel(env, agent) {
  return env.REMINDER_JUDGE_MODEL || agent.SONNET_MODEL;
}
