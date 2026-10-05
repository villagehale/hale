import type { RequestIntentReader } from './request-intent';
import type {
  RequestIntentAnswer,
  RequestIntentInput,
  RequestIntentLabel,
} from './request-intent-reading';

/**
 * A deterministic stand-in for the request-intent reader, for tests of the PLUMBING
 * around a reading: which turns reach the model, what a connect ask mints, what a
 * both-free ask plans, where the floor ends. Whether the real model reads a parent
 * well is proved by the cached eval (apps/worker/evals/run-request-intent-eval.mjs,
 * rule #8), not here.
 *
 * The default table is only a test convenience. It is not a product rule and nothing in
 * production imports it.
 */
export interface FakeRequestIntentReader extends RequestIntentReader {
  readonly calls: RequestIntentInput[];
}

const TEST_TABLE: ReadonlyArray<[RegExp, RequestIntentLabel]> = [
  [/\b(?:both free|free together|libres tous les deux|tous les deux libres)\b/i, 'both_free'],
  [/\bgmail\b/i, 'connect_gmail'],
  [/\bgoogle drive\b/i, 'connect_gdrive'],
  [/\b(?:calendar|calendrier|agenda|gcal)\b/i, 'connect_gcal'],
];

function tableRead(message: string): RequestIntentLabel {
  if (/^\s*(?:what|is|do|does|did|are)\b/i.test(message)) return 'other';
  if (/\b(?:disconnect|unlink|stop|don'?t|d[ée]connecte)\b/i.test(message)) return 'other';
  for (const [pattern, label] of TEST_TABLE) {
    if (pattern.test(message)) return label;
  }
  return 'other';
}

export function fakeRequestIntentReader(
  options: {
    /** Throw on every read, like a model outage. */
    fail?: boolean;
    /** Decide the label yourself; the fake still echoes the message verbatim. */
    label?: RequestIntentLabel | ((input: RequestIntentInput) => RequestIntentLabel);
    /** Return this answer wholesale (to test the guards: a paraphrased echo, a low confidence). */
    answer?: (input: RequestIntentInput) => RequestIntentAnswer;
  } = {},
): FakeRequestIntentReader {
  const calls: RequestIntentInput[] = [];
  return {
    calls,
    async read(input) {
      calls.push(input);
      if (options.fail) throw new Error('fake intent: model failed');
      if (options.answer) return options.answer(input);
      const intent =
        typeof options.label === 'function'
          ? options.label(input)
          : (options.label ?? tableRead(input.message));
      return { intent, verbatim: input.message, rationale: 'fake', confidence: 0.95 };
    },
  };
}
