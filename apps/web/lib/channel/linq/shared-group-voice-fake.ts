import type { SharedGroupLine } from './shared-group-line-input';
import type { SharedGroupComposer } from './shared-group-voice';

/**
 * A deterministic stand-in for the shared-group composer. Tests of seating,
 * silence, opt-out, and the ledger inject this. It does not call a model and
 * it does not judge prose. The line is never a production fallback.
 */
export interface FakeSharedGroupComposer extends SharedGroupComposer {
  readonly calls: { input: SharedGroupLine; prompt: 'full' | 'short' }[];
}

export function fakeSharedGroupComposer(
  options: {
    fail?: boolean;
    failFullPrompt?: boolean;
    decline?: boolean;
    body?: string | ((input: SharedGroupLine) => string);
  } = {},
): FakeSharedGroupComposer {
  const calls: FakeSharedGroupComposer['calls'] = [];
  return {
    calls,
    async compose(input, composeOptions) {
      const prompt = composeOptions?.prompt ?? 'full';
      calls.push({ input, prompt });
      if (options.fail || (options.failFullPrompt && prompt === 'full')) {
        throw new Error('fake shared-group voice: model failed');
      }
      if (options.decline && input.mayDecline) return { send: false, why: 'declined' };
      if (typeof options.body === 'function') {
        return { send: true, line: options.body(input) };
      }
      if (options.body !== undefined) return { send: true, line: options.body };
      const slots = Object.values(input.facts)
        .flatMap((value) => (value == null ? [] : [String(value)]))
        .join(' ');
      const line =
        input.questions === 1 ? `${input.kind} ${slots}?`.trim() : `${input.kind} ${slots}.`.trim();
      return { send: true, line };
    },
  };
}
