import type { GroupOnboardingLine } from './group-onboarding-line-input';
import type { GroupOnboardingComposer } from './group-onboarding-voice';

/**
 * A deterministic stand-in for the group-onboarding composer. Tests of seating,
 * dedupe, and the ledger inject this. It does not call a model and it does not
 * judge prose. The line repeats the facts code required so a test can see them.
 */
export interface FakeGroupOnboardingComposer extends GroupOnboardingComposer {
  readonly calls: { input: GroupOnboardingLine; prompt: 'full' | 'short' }[];
}

export function fakeGroupOnboardingComposer(
  options: {
    fail?: boolean;
    failFullPrompt?: boolean;
    body?: string | ((input: GroupOnboardingLine) => string);
  } = {},
): FakeGroupOnboardingComposer {
  const calls: FakeGroupOnboardingComposer['calls'] = [];
  return {
    calls,
    async compose(input, composeOptions) {
      const prompt = composeOptions?.prompt ?? 'full';
      calls.push({ input, prompt });
      if (options.fail || (options.failFullPrompt && prompt === 'full')) {
        throw new Error('fake voice: model failed');
      }
      if (typeof options.body === 'function') return { line: options.body(input) };
      if (options.body !== undefined) return { line: options.body };
      const mentioned = input.mustMention.join(' ');
      const line =
        input.questions === 1 ? `${input.kind}: ${mentioned}?` : `${input.kind}: ${mentioned}.`;
      return { line };
    },
  };
}
