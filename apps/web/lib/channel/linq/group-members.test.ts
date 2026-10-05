import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeSpokenLineComposer } from '~/lib/channel/voice/fakes';
import { linqGroupMembersEnabled } from './config';
import { holdUnknownGroupSender } from './group';
import { classifyParticipantAdd } from './group-members';
import { groupLineInput, speakGroupLine } from './group-voice';

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

describe('group member lines', () => {
  it('hands the model only the adder and the asking parent, and asks one question', () => {
    const withAdder = groupLineInput({ kind: 'member_welcome', adder: 'Sam' }, 'fr');
    expect(withAdder.facts).toEqual({ adder: 'Sam' });
    expect(withAdder.questions).toBe(1);
    expect(withAdder.address).toBe('vous');

    const noAdder = groupLineInput({ kind: 'member_welcome', adder: null }, 'en');
    expect(noAdder.facts).toEqual({ adder: null });

    const hold = groupLineInput({ kind: 'stranger_hold', parentA: 'Sam' }, 'en');
    expect(hold.mustMention).toEqual(['Sam']);
    expect(hold.questions).toBe(1);
  });

  it('refuses a welcome that carries family detail or compliance wording', async () => {
    const page = vi.fn(async () => 'sent' as const);
    const leaky = fakeSpokenLineComposer({
      body: "Hi, I'm Hale. Sam added you. Maya's swim is Saturday at 9:00. Reply STOP to opt out. What should I call you?",
    });
    const result = await speakGroupLine(leaky, { kind: 'member_welcome', adder: 'Sam' }, 'en', {
      page,
    });
    expect(result.source).toBe('unsent');
    expect(leaky.calls.map((call) => call.prompt)).toEqual(['full', 'short']);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('sends nothing about a family from an unclaimed group', async () => {
    const fetch = vi.fn();
    await expect(holdUnknownGroupSender({ chatId: 'chat-1', fetch })).resolves.toBe('not_sent');
    expect(fetch).not.toHaveBeenCalled();
  });
});
