import { describe, expect, it } from 'vitest';
import { judgeSpokenLine } from '../voice/judge';
import { groupOnboardingLineInput } from './group-onboarding-line-input';

/**
 * The STOP-wording ban every other voice line keeps is lifted only where the line must
 * carry the way out: the first 1:1 message to a seated parent, and the STOP
 * acknowledgement. Everywhere else in this flow STOP is still refused.
 */

const CONNECT = groupOnboardingLineInput(
  {
    kind: 'connect_link_1to1',
    name: null,
    knownParentName: 'Riley',
    providers: ['Google Calendar', 'Gmail'],
  },
  'en',
);

describe('group onboarding lines that carry the way out', () => {
  it('accepts STOP in the 1:1 link line, and refuses that line when it leaves STOP out', () => {
    expect(CONNECT).toMatchObject({ address: 'tu', linkFollows: true, wayOut: true });
    expect(
      judgeSpokenLine(
        "I'm Hale, the kids' year planner for Riley's family. These links connect your Google Calendar and Gmail, and nothing of yours shows in the group. Reply STOP to stop these messages.",
        CONNECT,
      ),
    ).toEqual({ ok: true });
    expect(
      judgeSpokenLine(
        "I'm Hale, the kids' year planner for Riley's family. These links connect your Google Calendar and Gmail.",
        CONNECT,
      ),
    ).toEqual({ ok: false, reason: 'missing' });
  });

  it('still refuses STOP wording in a group line that is not the acknowledgement', () => {
    const textMe = groupOnboardingLineInput({ kind: 'text_me_directly', name: 'Sam' }, 'en');
    expect(
      judgeSpokenLine(
        "Sam, I'm Hale. Send me a message directly and I'll set you up there. Reply STOP anytime.",
        textMe,
      ),
    ).toEqual({ ok: false, reason: 'compliance' });
    const ack = groupOnboardingLineInput({ kind: 'stop_ack' }, 'en');
    expect(
      judgeSpokenLine("Got it, you said STOP, so I won't write to you in this group.", ack),
    ).toEqual({ ok: true });
  });
});

/**
 * Someone added to an existing iMessage group does not see the messages before they
 * joined, so the ask they get is from a stranger unless it names Hale, and their answer
 * to it is the consent that seats them. A re-ask follows Hale's own line, so it does not.
 */
describe('who is asking', () => {
  it('names Hale in the ask to a newly added member, not in the re-ask', () => {
    for (const language of ['en', 'fr'] as const) {
      expect(
        groupOnboardingLineInput({ kind: 'member_ask', knownParentName: 'Riley' }, language)
          .mustMention,
      ).toContain('Hale');
      expect(groupOnboardingLineInput({ kind: 'role_reask' }, language).mustMention).not.toContain(
        'Hale',
      );
    }
  });
});

/**
 * "Vous êtes maman, papa, grand-parent, nounou, gardienne ou pas de la famille ?" offers
 * every role; "vous êtes la maman" and "you're the mom, right?" decide for someone. Only
 * the second shape is a role asserted.
 */
describe('role_asserted in an ask', () => {
  const reaskFr = groupOnboardingLineInput({ kind: 'role_reask' }, 'fr');
  const reaskEn = groupOnboardingLineInput({ kind: 'role_reask' }, 'en');

  it('accepts a choice list that opens with vous êtes / you are', () => {
    expect(
      judgeSpokenLine(
        'Pas de souci. Vous êtes maman, papa, grand-parent, nounou, gardienne, ou pas de la famille?',
        reaskFr,
      ),
    ).toEqual({ ok: true });
    expect(
      judgeSpokenLine(
        "No worries. You're the mom, dad, grandparent, nanny, babysitter, or not family?",
        reaskEn,
      ),
    ).toEqual({ ok: true });
  });

  it('still refuses a single role decided for the reader', () => {
    expect(
      judgeSpokenLine(
        'Vous êtes la maman, non? Sinon: maman, papa, grand-parent, nounou, gardienne, ou pas de la famille?',
        reaskFr,
      ),
    ).toEqual({ ok: false, reason: 'question' });
    expect(
      judgeSpokenLine(
        "You're the mom, right - or dad, grandparent, nanny, babysitter, or not family?",
        reaskEn,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:role_asserted' });
  });
});
