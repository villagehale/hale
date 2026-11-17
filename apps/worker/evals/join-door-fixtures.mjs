/**
 * VIL-706 · co-parent join and caregiver door lines.
 *
 * Each case is the request apps/web/lib/channel/door-line.ts hands the spoken-line
 * skill. The model writes the whole text. A line that names STOP, HELP, ARRET or
 * AIDE, or that drops a verbatim link, is a miss.
 */

const LINK = 'https://www.villagehale.com/text?s=join-0123456789abcdef0123456789abcdef';

export const JOIN_DOOR_FIXTURES = [
  {
    id: 'join-invite-forward',
    request: {
      purpose: 'join_invite_forward',
      language: 'en',
      facts: { link: LINK },
      verbatim: [LINK],
    },
    watchFor:
      'Includes the link unchanged. Says whoever opens it joins the family. No STOP or HELP.',
  },
  {
    id: 'join-welcome',
    request: {
      purpose: 'join_welcome',
      language: 'en',
      facts: { inviterName: 'Ana' },
      verbatim: [],
    },
    watchFor: 'Ana added them as a co-parent and they see what Ana sees. No STOP or HELP.',
  },
  {
    id: 'join-welcome-french',
    request: {
      purpose: 'join_welcome',
      language: 'fr',
      facts: { inviterName: 'Ana' },
      verbatim: [],
    },
    watchFor: 'Written in French. Names Ana. No STOP, HELP, ARRET or AIDE.',
  },
  {
    id: 'join-accepted-ack',
    request: { purpose: 'join_accepted_ack', language: 'en', facts: {}, verbatim: [] },
    watchFor:
      'Tells the inviting parent their partner joined and sees what they see. No STOP or HELP.',
  },
  {
    id: 'caregiver-welcome',
    request: {
      purpose: 'caregiver_welcome',
      language: 'en',
      facts: { role: 'grandparent' },
      verbatim: [],
    },
    watchFor: 'They get the week schedule and pickup reminders, and nothing else. No STOP or HELP.',
  },
  {
    id: 'caregiver-decline',
    request: { purpose: 'caregiver_decline_ack', language: 'en', facts: {}, verbatim: [] },
    watchFor: 'They said no. Hale will not text them again. No STOP or HELP.',
  },
  {
    id: 'caregiver-number-in-use',
    request: { purpose: 'caregiver_number_in_use', language: 'en', facts: {}, verbatim: [] },
    watchFor: 'The number already has a Hale setup. Does not say whose. No STOP or HELP.',
  },
  {
    id: 'caregiver-redirect',
    request: { purpose: 'caregiver_co_parent_redirect', language: 'en', facts: {}, verbatim: [] },
    watchFor:
      'A co-parent is not added from a typed number. Points at add my partner. No STOP or HELP.',
  },
];
