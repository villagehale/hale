import { describe, expect, it } from 'vitest';
import { gradeAckJudge, gradeAckRead } from './ack-eta-fixtures.mjs';

describe('ack-eta graders fail when the model is wrong', () => {
  it('a read passes only on the exact category', () => {
    expect(gradeAckRead({ task: 'find' }, 'find')).toBeNull();
    expect(gradeAckRead({ task: 'research' }, 'find')).toBe('read said research, expected find');
    expect(gradeAckRead({}, 'none')).toBe('read returned no task');
  });

  it('a verdict passes only on the exact set of problems, in any order', () => {
    expect(gradeAckJudge(['claims_done', 'no_time'], ['no_time', 'claims_done'])).toBeNull();
    expect(gradeAckJudge([], ['claims_done'])).toBe('judge named [], expected [claims_done]');
    expect(gradeAckJudge(['no_time'], [])).toBe('judge named [no_time], expected []');
  });
});
