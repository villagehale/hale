import type {
  MeaningScreen,
  MeaningScreenInput,
  MeaningScreenReading,
} from '~/lib/channel/meaning-screen/read';
import { blankMeaningReading } from '~/lib/channel/meaning-screen/scripted-reader.fixture';

/**
 * Test stand-in for the meaning screen on a family-memory turn. It reads no meaning:
 * each test says what the screen answers for its own text, so what is under test is the
 * request mechanics around the read (which facts are shown, by which ref, what is acted
 * on, what the reply is written from). How the model reads real wording, in English,
 * French and Chinese, is the meaning-screen eval's job (rule #8: no mocked judgement).
 */

export type MemoryScreenScript = {
  /** `memory_request`: the reading for this text, or null for an unread screen. */
  request?: (text: string) => Partial<MeaningScreenReading> | null;
  /** `memory_target`: the reading for this text over these ref'd facts. */
  target?: (text: string, facts: readonly string[]) => Partial<MeaningScreenReading> | null;
};

export interface ScriptedMemoryScreen extends MeaningScreen {
  calls: MeaningScreenInput[];
}

export function scriptedMemoryScreen(script: MemoryScreenScript): ScriptedMemoryScreen {
  const calls: MeaningScreenInput[] = [];
  return {
    calls,
    async read(input) {
      calls.push(input);
      if (input.screen === 'memory_request') {
        const over = script.request ? script.request(input.text) : null;
        return over ? blankMeaningReading(over) : null;
      }
      if (input.screen === 'memory_target') {
        const over = script.target ? script.target(input.text, input.facts ?? []) : null;
        return over ? blankMeaningReading(over) : null;
      }
      return blankMeaningReading();
    },
  };
}

/** A `memory_request` reading for a list, forget, or correct. */
export function asked(
  memory: 'list' | 'forget' | 'correct',
  over: Partial<MeaningScreenReading> = {},
): Partial<MeaningScreenReading> {
  return { hit: true, memory, language: 'en', ...over };
}

/** The refs of the shown facts whose data line starts with one of these keys. */
export function refsFor(facts: readonly string[], ...keys: string[]): string[] {
  const refs: string[] = [];
  for (const fact of facts) {
    const [ref, line] = fact.split(/: (.*)/s);
    if (!ref || !line) continue;
    if (keys.some((key) => line.startsWith(`${key}:`))) refs.push(ref);
  }
  return refs;
}
