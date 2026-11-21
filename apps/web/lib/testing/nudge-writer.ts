import {
  type NudgeWrite,
  composeNudgeMessage,
  nudgeFactSlots,
} from '~/lib/channel/nudge/nudge-voice';

/**
 * The model's turn on a nudge, for a sweep test about everything AROUND the words: the
 * gate, the ledger, the two seats, the hand-off. It answers with the decision's facts,
 * so a test can still see which nudge went out. The words themselves are the cached-real
 * nudge eval's job (apps/worker/evals), and the real composer's failure paths are pinned
 * in nudge-voice.test.ts.
 *
 * The two kinds whose writing is the subject of their own tests (the weekday-care ask,
 * the empty Saturday) go to the real composer, which is silent without a client.
 */
export const factNudgeWriter: typeof composeNudgeMessage = async (
  nudge,
  deps,
): Promise<NudgeWrite> => {
  if (nudge.kind === 'weekday_care' || nudge.kind === 'empty_saturday') {
    return composeNudgeMessage(nudge, deps);
  }
  return { message: nudgeFactSlots(nudge).join(' ') };
};
