import {
  type SpokenLineComposeOptions,
  type SpokenLineComposer,
  type SpokenLineInput,
  judgeSpokenLine,
  spokenFactSlots,
} from './spoken-line';

/**
 * A deterministic stand-in for the spoken-line composer, for tests of the
 * PLUMBING around a line: dedupe keys, gates, one send per event, the ledger.
 * Whether the real model writes a good line is proved by the cached eval
 * (apps/worker/evals/run-group-voice-eval.mjs, rule #8), not here.
 *
 * The fake writes `<kind>: <every fact and anchor>` with the asked number of
 * questions, so it passes the judge the real composer is held to and a test
 * can find the facts in the wire body. It records every request it saw.
 */
export interface FakeSpokenLineComposer extends SpokenLineComposer {
  readonly calls: {
    input: SpokenLineInput;
    prompt: 'full' | 'short';
    rejected: SpokenLineComposeOptions['rejected'];
  }[];
}

export function fakeSpokenLineComposer(
  options: {
    /** Throw on every compose, like a model outage. */
    fail?: boolean;
    /** Return this body instead (judged like any other). */
    body?: string | ((input: SpokenLineInput) => string);
    /** Fail only the full prompt, so the short retry is what succeeds. */
    failFullPrompt?: boolean;
  } = {},
): FakeSpokenLineComposer {
  const calls: FakeSpokenLineComposer['calls'] = [];
  return {
    calls,
    async compose(input, composeOptions) {
      const prompt = composeOptions?.prompt ?? 'full';
      calls.push({ input, prompt, rejected: composeOptions?.rejected });
      if (options.fail) throw new Error('fake voice: model failed');
      if (options.failFullPrompt && prompt === 'full') {
        throw new Error('fake voice: model failed');
      }
      if (options.body !== undefined) {
        return { line: typeof options.body === 'function' ? options.body(input) : options.body };
      }
      return { line: fakeSpokenLineBody(input) };
    },
  };
}

/** What the fake says for a request. Exported so a test can assert on the exact wire body. */
export function fakeSpokenLineBody(input: SpokenLineInput): string {
  const slots = [
    ...new Set(
      spokenFactSlots({ ...input, parentWords: null, recentTurns: [] }).filter(
        (slot) => slot.length > 0,
      ),
    ),
  ];
  const line = `${input.kind}: ${slots.join(', ')}${input.questions === 1 ? '?' : '.'}`;
  const judged = judgeSpokenLine(line, input);
  if (!judged.ok) {
    throw new Error(`fake voice wrote a line the judge refused (${judged.reason}): ${line}`);
  }
  return line;
}
