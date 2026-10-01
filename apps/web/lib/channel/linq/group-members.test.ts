import { afterEach, describe, expect, it, vi } from 'vitest';
import { linqGroupMembersEnabled } from './config';
import { LINQ_GROUP_UNKNOWN_HOLD } from './group';
import { LINQ_GROUP_MEMBER_WELCOME, classifyParticipantAdd } from './group-members';

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

describe('classifyParticipantAdd', () => {
  const participant = '+14165550199';

  it('welcomes a parent add and an unnamed actor, and seats Hale without that welcome', () => {
    expect(
      classifyParticipantAdd({
        participantPhone: participant,
        actorHandle: '+14165550111',
        isFromMe: false,
        actorIsHouseholdParent: true,
        actorIsHale: false,
      }),
    ).toEqual({ kind: 'parent', seat: true, welcome: true });

    expect(
      classifyParticipantAdd({
        participantPhone: participant,
        actorHandle: null,
        isFromMe: false,
        actorIsHouseholdParent: false,
        actorIsHale: false,
      }),
    ).toEqual({ kind: 'unnamed', seat: true, welcome: true });

    expect(
      classifyParticipantAdd({
        participantPhone: participant,
        actorHandle: '+16462352164',
        isFromMe: true,
        actorIsHouseholdParent: false,
        actorIsHale: true,
      }),
    ).toEqual({ kind: 'hale', seat: true, welcome: false });
  });

  it('does not seat a named stranger', () => {
    expect(
      classifyParticipantAdd({
        participantPhone: participant,
        actorHandle: '+14165550999',
        isFromMe: false,
        actorIsHouseholdParent: false,
        actorIsHale: false,
      }),
    ).toEqual({ kind: 'other', seat: false, welcome: false });
  });
});

describe('group member copy', () => {
  it('uses the design placeholder and the existing hold, with no opt-out wording', () => {
    expect(LINQ_GROUP_MEMBER_WELCOME.startsWith('TODO-Design:')).toBe(true);
    expect(LINQ_GROUP_MEMBER_WELCOME.toLowerCase()).not.toContain('stop');
    expect(LINQ_GROUP_UNKNOWN_HOLD.toLowerCase()).not.toContain('stop');
  });
});
