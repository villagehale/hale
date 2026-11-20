import type { GroupExperienceComposer, GroupExperienceLineInput } from './voice';

export interface FakeGroupExperienceComposer extends GroupExperienceComposer {
  readonly calls: { input: GroupExperienceLineInput; prompt: 'full' | 'short' }[];
}

export function fakeGroupExperienceComposer(
  options: {
    fail?: boolean;
    leak?: string;
    body?: string | ((input: GroupExperienceLineInput) => string);
    optionLabels?: string[];
  } = {},
): FakeGroupExperienceComposer {
  const calls: FakeGroupExperienceComposer['calls'] = [];
  return {
    calls,
    async compose(input, composeOptions) {
      const prompt = composeOptions?.prompt ?? 'full';
      calls.push({ input, prompt });
      if (options.fail) throw new Error('fake voice: model failed');
      const fallback = input.questions === 1 ? `${input.kind}?` : `${input.kind}.`;
      const line =
        options.leak ??
        (typeof options.body === 'function' ? options.body(input) : (options.body ?? fallback));
      const optionLabels =
        options.optionLabels ??
        (input.kind === 'rsvp_open'
          ? ['in', 'out', 'maybe']
          : input.kind === 'time_open'
            ? ['Sat 10', 'Sun 10']
            : []);
      return { line, options: optionLabels };
    },
  };
}
