import { afterEach, describe, expect, it, vi } from 'vitest';
import { linqGroupMembersEnabled } from './config';
import { holdUnknownGroupSender } from './group';
import {
  GROUP_MEMBER_WELCOME_NO_ADDER,
  GROUP_MEMBER_WELCOME_WITH_ADDER,
  GROUP_STRANGER_HOLD,
  classifyParticipantAdd,
  groupMemberWelcome,
  groupStrangerHold,
} from './group-members';

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
  it('keeps each welcome and hold byte for byte, with no family detail and no opt-out', () => {
    expect(GROUP_MEMBER_WELCOME_WITH_ADDER.en).toBe(
      "Hi, I'm Hale. {adder} added you so the family can sort the week in one place. What should I call you?",
    );
    expect(GROUP_MEMBER_WELCOME_WITH_ADDER.fr).toBe(
      "Bonjour, c'est Hale. {adder} vous a ajoute pour qu'on s'organise ensemble. Comment je vous appelle?",
    );
    expect(GROUP_MEMBER_WELCOME_NO_ADDER.en).toBe(
      "Hi, I'm Hale. I help the family sort the week in one place. What should I call you?",
    );
    expect(GROUP_MEMBER_WELCOME_NO_ADDER.fr).toBe(
      "Bonjour, c'est Hale. J'aide la famille a organiser la semaine au meme endroit. Comment je vous appelle?",
    );
    expect(GROUP_STRANGER_HOLD.en).toBe(
      'Someone new joined this chat and I don\'t know them yet, so I\'m pausing here. {parentA}, say "add them" if they share the load.',
    );
    expect(GROUP_STRANGER_HOLD.fr).toBe(
      'Une nouvelle personne s\'est jointe a la conversation et je ne la connais pas encore, alors je fais une pause. {parentA}, dis "ajoute cette personne" si elle partage la charge.',
    );
    expect(groupMemberWelcome('en', 'Sam')).toBe(
      "Hi, I'm Hale. Sam added you so the family can sort the week in one place. What should I call you?",
    );
    expect(groupMemberWelcome('fr', 'Sam')).toBe(
      "Bonjour, c'est Hale. Sam vous a ajoute pour qu'on s'organise ensemble. Comment je vous appelle?",
    );
    expect(groupMemberWelcome('en', null)).toBe(GROUP_MEMBER_WELCOME_NO_ADDER.en);
    expect(groupMemberWelcome('fr', '  ')).toBe(GROUP_MEMBER_WELCOME_NO_ADDER.fr);
    expect(groupStrangerHold('en', 'Sam')).toBe(
      'Someone new joined this chat and I don\'t know them yet, so I\'m pausing here. Sam, say "add them" if they share the load.',
    );
    expect(groupStrangerHold('fr', 'Sam')).toBe(
      'Une nouvelle personne s\'est jointe a la conversation et je ne la connais pas encore, alors je fais une pause. Sam, dis "ajoute cette personne" si elle partage la charge.',
    );
    for (const line of [
      ...Object.values(GROUP_MEMBER_WELCOME_WITH_ADDER),
      ...Object.values(GROUP_MEMBER_WELCOME_NO_ADDER),
      ...Object.values(GROUP_STRANGER_HOLD),
      groupMemberWelcome('en', 'Sam'),
      groupStrangerHold('fr', 'Sam'),
    ]) {
      expect(line).toMatch(/^[\x20-\x7E]+$/);
      expect(line.toLowerCase()).not.toContain('stop');
      expect(line).not.toMatch(/\b(swim|postal|birthday|calendar)\b/i);
    }
  });

  it('sends nothing about a family from an unclaimed group', async () => {
    const fetch = vi.fn();
    await expect(holdUnknownGroupSender({ chatId: 'chat-1', fetch })).resolves.toBe('not_sent');
    expect(fetch).not.toHaveBeenCalled();
  });
});
