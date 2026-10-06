import { afterEach, describe, expect, it, vi } from 'vitest';
import { linqGroupMembersEnabled } from './config';
import { holdUnknownGroupSender } from './group';
import * as groupMembers from './group-members';

describe('LINQ_GROUP_MEMBERS_ENABLED', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is on only when the flag is exactly true', () => {
    vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'true');
    expect(linqGroupMembersEnabled()).toBe(true);
    vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'on');
    expect(linqGroupMembersEnabled()).toBe(false);
    vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', '');
    expect(linqGroupMembersEnabled()).toBe(false);
    vi.unstubAllEnvs();
    expect(linqGroupMembersEnabled()).toBe(false);
  });
});

describe('group members', () => {
  it('keeps no guessing seat, no welcome copy and no stranger hold', () => {
    for (const gone of [
      'classifyParticipantAdd',
      'seatParticipantAdded',
      'holdTrueStrangerOnce',
      'groupMemberWelcome',
      'groupStrangerHold',
      'GROUP_MEMBER_WELCOME_WITH_ADDER',
      'GROUP_MEMBER_WELCOME_NO_ADDER',
      'GROUP_STRANGER_HOLD',
    ]) {
      expect(gone in groupMembers).toBe(false);
    }
    expect('askParticipantAdded' in groupMembers).toBe(true);
  });

  it('sends nothing about a family from an unclaimed group', async () => {
    const fetch = vi.fn();
    await expect(holdUnknownGroupSender({ chatId: 'chat-1', fetch })).resolves.toBe('not_sent');
    expect(fetch).not.toHaveBeenCalled();
  });
});
