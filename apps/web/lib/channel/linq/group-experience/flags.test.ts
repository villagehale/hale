import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupBringListEnabled, groupSharedListsEnabled } from '~/lib/channel/lists/flag';
import {
  groupCarpoolEnabled,
  groupExperienceTurnEnabled,
  groupLinkCardsEnabled,
  groupMailNoticeEnabled,
  groupPollsEnabled,
  groupPrivateQuestionEnabled,
  linqGroupCarpoolEnabled,
} from '../config';

describe('VIL-399 group experience flags', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stay dark unless the value is exactly true after trimming', () => {
    expect(groupPollsEnabled()).toBe(false);
    expect(groupLinkCardsEnabled()).toBe(false);
    expect(groupCarpoolEnabled()).toBe(false);
    expect(groupPrivateQuestionEnabled()).toBe(false);
    expect(groupMailNoticeEnabled()).toBe(false);
    expect(groupExperienceTurnEnabled()).toBe(false);
    expect(groupBringListEnabled()).toBe(false);

    for (const value of ['on', 'false', 'TRUE', '1', '']) {
      vi.stubEnv('GROUP_POLLS_ENABLED', value);
      expect(groupPollsEnabled()).toBe(false);
    }
    vi.stubEnv('GROUP_POLLS_ENABLED', 'true');
    expect(groupPollsEnabled()).toBe(true);
    vi.stubEnv('GROUP_POLLS_ENABLED', 'true\n');
    expect(groupPollsEnabled()).toBe(true);
  });

  it('GROUP_CARPOOL_ENABLED arms the existing carpool path', () => {
    vi.stubEnv('LINQ_GROUP_CARPOOL_ENABLED', '');
    vi.stubEnv('GROUP_CARPOOL_ENABLED', 'true');
    expect(groupCarpoolEnabled()).toBe(true);
    expect(linqGroupCarpoolEnabled()).toBe(true);
  });

  it('GROUP_BRING_LIST_ENABLED arms shared lists', () => {
    expect(groupSharedListsEnabled({})).toBe(false);
    expect(groupSharedListsEnabled({ GROUP_BRING_LIST_ENABLED: 'on' })).toBe(false);
    expect(groupSharedListsEnabled({ GROUP_BRING_LIST_ENABLED: 'true' })).toBe(true);
    expect(groupBringListEnabled({ GROUP_BRING_LIST_ENABLED: 'true\n' })).toBe(true);
  });
});
