import { describe, expect, it } from 'vitest';
import { lineHealthKnown, lineHealthPauses } from './line-health';

describe('line health', () => {
  it('pauses on a CRITICAL reputation or a FLAGGED line, and not on an active, healthy one', () => {
    expect(lineHealthPauses({ status: 'ACTIVE', reputation: 'CRITICAL' })).toBe(true);
    expect(lineHealthPauses({ status: 'FLAGGED', reputation: 'HEALTHY' })).toBe(true);
    expect(lineHealthPauses({ status: 'ACTIVE', reputation: 'HEALTHY' })).toBe(false);
    expect(lineHealthPauses({ status: 'ACTIVE', reputation: 'AT_RISK' })).toBe(false);
    expect(lineHealthPauses({ status: 'active', reputation: 'healthy' })).toBe(false);
  });
  it('fails closed on a status or reputation word it does not know', () => {
    expect(lineHealthPauses({ status: 'SUSPENDED', reputation: 'HEALTHY' })).toBe(true);
    expect(lineHealthPauses({ status: 'ACTIVE', reputation: 'UNKNOWN' })).toBe(true);
    expect(lineHealthKnown({ status: 'SUSPENDED', reputation: 'HEALTHY' })).toBe(false);
    expect(lineHealthKnown({ status: 'ACTIVE', reputation: 'UNKNOWN' })).toBe(false);
    expect(lineHealthKnown({ status: 'FLAGGED', reputation: 'AT_RISK' })).toBe(true);
  });
});
