import type { GroupPlanRsvpLineInput } from './facts';
import type { GroupPlanRsvpComposer } from './voice';

/**
 * A deterministic stand-in for the group-plan RSVP composer. Tests of tally,
 * settle, follow-up claims, and the ledger inject this. It does not call a
 * model and it does not judge prose. The line repeats the facts code required
 * so a test can see them — it is not a parent-facing fallback.
 */
export interface FakeGroupPlanRsvpComposer extends GroupPlanRsvpComposer {
  readonly calls: { input: GroupPlanRsvpLineInput; prompt: 'full' | 'short' }[];
}

export function fakeGroupPlanRsvpComposer(
  options: {
    fail?: boolean;
    failFullPrompt?: boolean;
    body?: string | ((input: GroupPlanRsvpLineInput) => string);
  } = {},
): FakeGroupPlanRsvpComposer {
  const calls: FakeGroupPlanRsvpComposer['calls'] = [];
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
      const facts = input.facts;
      const count = `${facts.yesCount} ${facts.toGo}`;
      const names = [...facts.yesNames, ...facts.waitingNames].join(' ');
      const line =
        input.questions === 1
          ? `${input.kind} ${facts.title} ${count} ${names}?`
          : `${input.kind} ${facts.title} ${count} ${names}.`;
      return { line };
    },
  };
}
