import type { CheckInIntentReader } from './intent';
import type { CheckInIntentAnswer, CheckInIntentInput, CheckInIntentLabel } from './intent-reading';

/**
 * A deterministic stand-in for the check-in intent reader, for tests of the PLUMBING
 * around a reading: which turns reach the model, what a cadence change writes, where
 * the floor ends. Whether the real model reads a parent well is proved by the cached
 * eval (apps/worker/evals/run-checkin-intent-eval.mjs, rule #8), not here.
 *
 * The default table is only a test convenience. It is not a product rule and nothing in
 * production imports it.
 */
export interface FakeCheckInIntentReader extends CheckInIntentReader {
  readonly calls: CheckInIntentInput[];
}

const TEST_TABLE: Record<string, CheckInIntentLabel> = {
  less: 'cadence_weekly',
  weekly: 'cadence_weekly',
  'less often please': 'cadence_weekly',
  'moins souvent': 'cadence_weekly',
  no: 'cadence_off',
  non: 'cadence_off',
  'no thanks': 'cadence_off',
  'stop asking': 'cadence_off',
  'non merci': 'cadence_off',
  daily: 'cadence_daily',
  nightly: 'cadence_daily',
  'every night please': 'cadence_daily',
  'tous les soirs': 'cadence_daily',
  ok: 'other',
  thanks: 'other',
  hi: 'other',
};

function tableRead(reply: string): CheckInIntentLabel {
  const folded = reply
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');
  const listed = TEST_TABLE[folded];
  if (listed) return listed;
  return reply.includes('?') ? 'request' : 'day_note';
}

export function fakeCheckInIntentReader(
  options: {
    /** Throw on every read, like a model outage. */
    fail?: boolean;
    /** Decide the label yourself; the fake still echoes the reply verbatim. */
    label?: CheckInIntentLabel | ((input: CheckInIntentInput) => CheckInIntentLabel);
    /** Return this answer wholesale (to test the guards: a paraphrased echo, a low confidence). */
    answer?: (input: CheckInIntentInput) => CheckInIntentAnswer;
  } = {},
): FakeCheckInIntentReader {
  const calls: CheckInIntentInput[] = [];
  return {
    calls,
    async read(input) {
      calls.push(input);
      if (options.fail) throw new Error('fake intent: model failed');
      if (options.answer) return options.answer(input);
      const intent =
        typeof options.label === 'function'
          ? options.label(input)
          : (options.label ?? tableRead(input.reply));
      return { intent, verbatim: input.reply, rationale: 'fake', confidence: 0.95 };
    },
  };
}
