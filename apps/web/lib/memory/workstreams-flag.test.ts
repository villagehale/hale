import { describe, expect, it } from 'vitest';
import { WORKSTREAMS_ENABLED_ENV, workstreamsEnabled } from './workstreams';

describe('WORKSTREAMS_ENABLED', () => {
  it('is on only for the exact string true', () => {
    expect(workstreamsEnabled({ [WORKSTREAMS_ENABLED_ENV]: 'true' })).toBe(true);
    expect(workstreamsEnabled({ [WORKSTREAMS_ENABLED_ENV]: 'true\n' })).toBe(false);
    expect(workstreamsEnabled({ [WORKSTREAMS_ENABLED_ENV]: 'TRUE' })).toBe(false);
    expect(workstreamsEnabled({})).toBe(false);
  });
});
