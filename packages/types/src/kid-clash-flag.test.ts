import { describe, expect, it } from 'vitest';
import { KID_CLASH_NOTICE_ENABLED_ENV, kidClashNoticeEnabled } from './kid-clash-flag.js';

describe('kidClashNoticeEnabled', () => {
  it('is on only for the exact string true', () => {
    expect(kidClashNoticeEnabled({ [KID_CLASH_NOTICE_ENABLED_ENV]: 'true' })).toBe(true);
  });

  it('stays off for every other value, including a trailing newline and unset', () => {
    expect(kidClashNoticeEnabled({})).toBe(false);
    expect(kidClashNoticeEnabled({ [KID_CLASH_NOTICE_ENABLED_ENV]: '' })).toBe(false);
    expect(kidClashNoticeEnabled({ [KID_CLASH_NOTICE_ENABLED_ENV]: 'true\n' })).toBe(false);
    expect(kidClashNoticeEnabled({ [KID_CLASH_NOTICE_ENABLED_ENV]: 'TRUE' })).toBe(false);
    expect(kidClashNoticeEnabled({ [KID_CLASH_NOTICE_ENABLED_ENV]: '1' })).toBe(false);
    expect(kidClashNoticeEnabled({ [KID_CLASH_NOTICE_ENABLED_ENV]: 'on' })).toBe(false);
    expect(kidClashNoticeEnabled({ [KID_CLASH_NOTICE_ENABLED_ENV]: 'false' })).toBe(false);
  });
});
