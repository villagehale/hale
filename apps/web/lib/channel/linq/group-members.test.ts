import { afterEach, describe, expect, it, vi } from 'vitest';
import { linqGroupMembersEnabled } from './config';
import { holdUnknownGroupSender } from './group';
import { classifyParticipantAdd, groupStrangerHold } from './group-members';

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

  it('seats and welcomes only a named household parent add', () => {
    expect(
      classifyParticipantAdd({
        participantPhone: participant,
        actorHandle: '+14165550111',
        isFromMe: false,
        actorIsHouseholdParent: true,
        actorIsHale: false,
      }),
    ).toEqual({ kind: 'parent', seat: true, welcome: true });
  });

  it('seats nobody when Linq names no actor or Hale is the actor', () => {
    expect(
      classifyParticipantAdd({
        participantPhone: participant,
        actorHandle: null,
        isFromMe: false,
        actorIsHouseholdParent: false,
        actorIsHale: false,
      }),
    ).toEqual({ kind: 'unnamed', seat: false, welcome: false });

    expect(
      classifyParticipantAdd({
        participantPhone: participant,
        actorHandle: '+16462352164',
        isFromMe: true,
        actorIsHouseholdParent: false,
        actorIsHale: true,
      }),
    ).toEqual({ kind: 'hale', seat: false, welcome: false });
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
  it('keeps each hold byte for byte, with no family detail and no opt-out', async () => {
    const holdEn = await groupStrangerHold('en', 'Sam');
    const holdFr = await groupStrangerHold('fr', 'Sam');
    expect(holdEn).toBe(
      'Someone new joined this chat and I don\'t know them yet, so I\'m pausing here. Sam, say "add them" if they share the load.',
    );
    expect(holdFr).toBe(
      'Une nouvelle personne s\'est jointe a la conversation et je ne la connais pas encore, alors je fais une pause. Sam, dis "ajoute cette personne" si elle partage la charge.',
    );
    expect(holdEn).toContain('Sam');
    expect(holdFr).toContain('Sam');
    for (const line of [holdEn, holdFr]) {
      expect(line ?? '').toMatch(/^[\x20-\x7E]+$/);
      expect((line ?? '').toLowerCase()).not.toContain('stop');
      expect(line ?? '').not.toMatch(/\b(swim|postal|birthday|calendar)\b/i);
    }
  });

  it('sends nothing about a family from an unclaimed group', async () => {
    const fetch = vi.fn();
    await expect(holdUnknownGroupSender({ chatId: 'chat-1', fetch })).resolves.toBe('not_sent');
    expect(fetch).not.toHaveBeenCalled();
  });
});
