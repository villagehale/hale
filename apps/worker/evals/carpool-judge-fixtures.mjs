/**
 * VIL-445 cases a judge grades for meaning, 1 to 5. Nothing here matches words.
 *
 * A pass is score >= 4 plus a reason. A miss, a throw, or a verdict with no
 * reason is `judge_unsent`.
 */

export const CARPOOL_JUDGE_CASES = [
  {
    id: 'driver-swap',
    situation:
      'Maya said she would drive Saturday soccer. Mid-thread Priya takes the drive instead. Hale’s later night-before reminder is for this plan.',
    rubric:
      'Score 5 if Hale treats Priya as the driver and does not keep Maya as the person to remind. Score 1–2 if Maya is still the driver, if Hale invents a rota, or if it ignores the swap.',
  },
  {
    id: 'no-driver-ask-once',
    situation:
      'The group named Saturday soccer and a pickup and nobody claimed the drive. Someone then talks about snacks, still with no driver.',
    rubric:
      'Score 5 if Hale asks once who is driving and does not ask again on the snack line. Score 1–2 if it never asks, asks twice, or assigns a driver nobody claimed.',
  },
  {
    id: 'quiet-hours',
    situation:
      'Luis is driving Saturday. It is 21:30 in his zone, inside quiet hours, the night before the pickup.',
    rubric:
      'Score 5 if Hale does not send the reminder in that hour. Score 1–2 if it texts through quiet hours.',
  },
  {
    id: 'cancelled',
    situation:
      'Maya was driving Saturday soccer. The group then cancelled the game. The night-before tick still runs.',
    rubric:
      'Score 5 if Hale sends nothing about that drive. Score 1–2 if a reminder still leaves.',
  },
];

/**
 * @param {{ id: string, situation: string, rubric: string }} item
 * @param {string} observation
 * @param {(input: { id: string, situation: string, rubric: string, observation: string }) => Promise<{ score?: number, reason?: string } | null>} judge
 */
export async function gradeCarpool(item, observation, judge) {
  if (typeof observation !== 'string') return { id: item.id, pass: false, reason: 'judge_unsent' };
  let verdict;
  try {
    verdict = await judge({
      id: item.id,
      situation: item.situation,
      rubric: item.rubric,
      observation,
    });
  } catch {
    return { id: item.id, pass: false, reason: 'judge_unsent' };
  }
  if (
    !verdict ||
    typeof verdict.score !== 'number' ||
    verdict.score < 1 ||
    verdict.score > 5 ||
    typeof verdict.reason !== 'string' ||
    verdict.reason.trim() === ''
  ) {
    return { id: item.id, pass: false, reason: 'judge_unsent' };
  }
  return { id: item.id, pass: verdict.score >= 4, score: verdict.score, reason: verdict.reason };
}
