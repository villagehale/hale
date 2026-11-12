import { afterEach, describe, expect, it, vi } from 'vitest';
import { postMailNoticeToHouseholdGroup } from './mail-notice';

describe('postMailNoticeToHouseholdGroup', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stays quiet while GROUP_MAIL_NOTICE_ENABLED is off', async () => {
    const result = await postMailNoticeToHouseholdGroup({} as never, {
      familyId: 'fam-1',
      eventId: 'evt-1',
      change: { field: 'time', previousStartsAt: new Date('2026-11-14T15:00:00.000Z') },
      timeZone: 'America/Toronto',
      now: new Date('2026-11-11T12:00:00.000Z'),
    });
    expect(result).toBe('skipped');
  });
});
