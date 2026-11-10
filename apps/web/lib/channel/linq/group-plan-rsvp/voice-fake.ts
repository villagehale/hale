import type { GroupLineInput, GroupPlanRsvpComposer } from './voice';

/**
 * A deterministic stand-in for the group-plan RSVP and poll composer. Tests of
 * tally, settle, follow-up claims, and the ledger inject this. It does not call
 * a model and it does not judge prose. The line repeats the facts code required
 * so a test can see them — it is not a parent-facing fallback.
 */
export interface FakeGroupPlanRsvpComposer extends GroupPlanRsvpComposer {
  readonly calls: { input: GroupLineInput; prompt: 'full' | 'short' }[];
}

function factsLine(input: GroupLineInput): string {
  if (input.skill === 'group-poll-voice') {
    const facts = input.facts;
    const counts = facts.options.map((option) => `${option.text}=${option.votes}`).join(' ');
    return `${input.kind} ${facts.question ?? ''} ${counts} ${facts.waitingNames.join(' ')}`;
  }
  const facts = input.facts;
  const count = `${facts.yesCount} ${facts.toGo}`;
  const names = [...facts.yesNames, ...facts.waitingNames].join(' ');
  return `${input.kind} ${facts.title} ${count} ${names}`;
}

export function fakeGroupPlanRsvpComposer(
  options: {
    fail?: boolean;
    failFullPrompt?: boolean;
    body?: string | ((input: GroupLineInput) => string);
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
      const line = factsLine(input);
      return { line: input.questions === 1 ? `${line}?` : `${line}.` };
    },
  };
}
