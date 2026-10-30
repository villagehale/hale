import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractionFailure, keepKnownTags } from './verdict';

/**
 * WHAT A FAILED READ IS ALLOWED TO SAY ABOUT ITSELF.
 *
 * This outcome is logged, and the thing that failed had the parent's own sentence in
 * front of it: `schema.parse` quotes the value it rejected, and an invented verdict is
 * routinely a phrase lifted straight out of what they typed. So the reason is a code
 * from a closed list and the message never travels (rule #1).
 */
describe('why an extraction failed', () => {
  it('says schema_rejected without repeating what the model wrote', () => {
    const rejected = z.enum(['worth_it', 'none']).safeParse('she loved the wednesday class');
    const err = rejected.success ? new Error('unreachable') : rejected.error;

    const reason = extractionFailure(err);

    expect(reason).toBe('schema_rejected');
    // The control that this is a real leak path: the error itself DOES carry it.
    expect(String(err)).toContain('she loved the wednesday class');
    expect(reason).not.toContain('loved');
  });

  it('separates a clipped answer from a provider failure', () => {
    expect(
      extractionFailure(new Error('activity_verdict: tool call truncated at max_tokens (512)')),
    ).toBe('truncated');
    expect(
      extractionFailure(new Error('activity_verdict: model returned no activity_verdict tool call')),
    ).toBe('no_tool_call');
    expect(extractionFailure(new Error('529 overloaded_error'))).toBe('call_failed');
    expect(extractionFailure('a thrown string')).toBe('call_failed');
  });
});

describe('the eight tags, and nothing else', () => {
  it('keeps the known ones, counts the invented ones, and stops at three', () => {
    expect(
      keepKnownTags(['well_run', 'lovely_staff', 'hard_parking', 'pricey', 'too_crowded']),
    ).toEqual({ tags: ['well_run', 'hard_parking', 'pricey'], dropped: 1 });
  });

  it('does not count one tag twice', () => {
    expect(keepKnownTags(['pricey', 'pricey'])).toEqual({ tags: ['pricey'], dropped: 0 });
  });
});
