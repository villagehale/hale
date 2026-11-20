/**
 * VIL-706 · the join and caregiver doors, the caregiver reminder, and the door's consent
 * asks with JOIN_DOOR_MODEL_COPY_ENABLED lit. Synthetic people only.
 *
 * Three subjects, each called the way production calls it (run-join-door-eval.mjs):
 *
 * - `JOIN_DOOR_FIXTURES`: the request apps/web/lib/channel/door-line.ts hands the
 *   spoken-line writer, which carries the `door-line` addendum. One per purpose at least.
 * - `CAREGIVER_REMINDER_FIXTURES`: the input apps/web/lib/loop/templates/caregiver/compose.ts
 *   `caregiverReminderRequest` turns into a spoken-line request with the
 *   `caregiver-reminder` addendum. The runner builds the request with that same function.
 * - `CONSENT_KEYWORDLESS_FIXTURES`: a consent ask of one of the four stranger kinds, which
 *   lit carries the `consent-ask-no-keyword` addendum.
 *
 * A line is a miss when the production acceptance refuses it (empty, a missing verbatim
 * piece, a stray link or number, an opt-out keyword), or when the friend-voice judge's
 * compliance check refuses it. `watchFor` is what a human reading the recording checks.
 */

const LINK = 'https://www.villagehale.com/text?s=join-0123456789abcdef0123456789abcdef';

/** @param {string} id @param {string} purpose @param {Record<string, string>} facts @param {string} watchFor @param {{ language?: string, verbatim?: string[] }} [extra] */
function door(id, purpose, facts, watchFor, extra = {}) {
  return {
    id,
    request: {
      purpose,
      language: extra.language ?? 'en',
      facts,
      verbatim: extra.verbatim ?? [],
    },
    watchFor,
  };
}

export const JOIN_DOOR_FIXTURES = [
  door(
    'join-invite-forward',
    'join_invite_forward',
    { link: LINK },
    'Includes the link unchanged. Says whoever opens it joins the family and it lasts 7 days. No STOP or HELP.',
    { verbatim: [LINK] },
  ),
  door(
    'join-invite-forward-french',
    'join_invite_forward',
    { link: LINK },
    'In French. The link unchanged, only for that person, 7 days. No STOP, HELP, ARRET or AIDE.',
    { language: 'fr', verbatim: [LINK] },
  ),
  door(
    'join-welcome',
    'join_welcome',
    { inviterName: 'Ana' },
    'Ana added them as a co-parent and they see what Ana sees. No STOP or HELP.',
  ),
  door(
    'join-welcome-french',
    'join_welcome',
    { inviterName: 'Ana' },
    'Written in French. Names Ana. No STOP, HELP, ARRET or AIDE.',
    { language: 'fr' },
  ),
  door(
    'join-welcome-unnamed',
    'join_welcome',
    { inviterName: '' },
    'No name invented: says their co-parent added them. No STOP or HELP.',
  ),
  door(
    'join-accepted-ack',
    'join_accepted_ack',
    {},
    'Tells the inviting parent their partner joined and sees what they see. No STOP or HELP.',
  ),
  door(
    'caregiver-welcome',
    'caregiver_welcome',
    { role: 'grandparent' },
    'They get the week schedule and pickup reminders, and nothing else. No STOP or HELP.',
  ),
  door(
    'caregiver-welcome-nanny-french',
    'caregiver_welcome',
    { role: 'nanny' },
    'In French. Schedule and pickup reminders, nothing else. No STOP, HELP, ARRET or AIDE.',
    { language: 'fr' },
  ),
  door(
    'caregiver-decline',
    'caregiver_decline_ack',
    {},
    'They said no. Hale will not text them again. No STOP or HELP.',
  ),
  door(
    'caregiver-invite-sent',
    'caregiver_invite_sent',
    { name: 'grandma' },
    'Grandma was texted and is in once she says yes. No STOP or HELP.',
  ),
  door(
    'caregiver-invite-dropped',
    'caregiver_invite_dropped',
    { name: 'grandma' },
    'Grandma was not texted. No STOP or HELP.',
  ),
  door(
    'caregiver-add-example',
    'caregiver_add_example',
    {},
    'Asks for who, their number, and grandparent, nanny or babysitter. No STOP or HELP.',
  ),
  door(
    'caregiver-redirect',
    'caregiver_co_parent_redirect',
    {},
    'A co-parent is not added from a typed number. Points at add my partner. No STOP or HELP.',
  ),
  door(
    'caregiver-number-in-use',
    'caregiver_number_in_use',
    {},
    'The number already has a Hale setup. Does not say whose. No STOP or HELP.',
  ),
  door(
    'caregiver-own-number',
    'caregiver_own_number',
    {},
    'That is their own number and they are already here. No STOP or HELP.',
  ),
  door(
    'caregiver-already-invited',
    'caregiver_already_invited',
    {},
    'Already texted, not answered yet, will tell the parent. No STOP or HELP.',
  ),
  door(
    'caregiver-cannot-text',
    'caregiver_cannot_text',
    {},
    'Will not text that number; they can text first. Says nothing about why. No STOP or HELP.',
  ),
  door(
    'caregiver-too-many',
    'caregiver_too_many',
    {},
    'A lot of people today, nobody new texted, tomorrow. No STOP or HELP.',
  ),
  door(
    'caregiver-scoped-reply',
    'caregiver_scoped_reply',
    { parentName: 'Sam' },
    'Only the schedule here; take it to Sam. Repeats nothing they asked. No STOP or HELP.',
  ),
  door(
    'caregiver-scoped-reply-unnamed',
    'caregiver_scoped_reply',
    { parentName: '' },
    'Only the schedule here; take it to the parents. No name invented. No STOP or HELP.',
  ),
];

const TZ = 'America/Toronto';

export const CAREGIVER_REMINDER_FIXTURES = [
  {
    id: 'caregiver-reminder-hour-before',
    input: {
      offset: '-PT1H',
      timeZone: TZ,
      now: '2026-07-25T19:15:00Z',
      language: 'en',
      events: [
        {
          title: 'Swim class',
          startsAt: '2026-07-25T20:15:00Z',
          endsAt: '2026-07-25T21:00:00Z',
          location: 'Stouffville Public School, 2 Park Drive',
        },
      ],
    },
    watchFor:
      'Swim class at 4:15 this afternoon, in about an hour, at the school with its street. No question. No STOP or HELP.',
  },
  {
    id: 'caregiver-reminder-evening-two',
    input: {
      offset: '-P1D',
      timeZone: TZ,
      now: '2026-07-24T22:00:00Z',
      language: 'en',
      events: [
        {
          title: 'Swim class',
          startsAt: '2026-07-25T14:00:00Z',
          endsAt: '2026-07-25T14:45:00Z',
          location: 'Stouffville Leisure Centre, 2 Park Drive',
        },
        {
          title: 'Soccer',
          startsAt: '2026-07-25T18:00:00Z',
          endsAt: null,
          location: 'Memorial Park',
        },
      ],
    },
    watchFor:
      'Both tomorrow: swim at 10:00 AM at the leisure centre, soccer at 2:00 PM at Memorial Park. No question. No STOP or HELP.',
  },
  {
    id: 'caregiver-reminder-french',
    input: {
      offset: '-PT1H',
      timeZone: TZ,
      now: '2026-07-25T19:15:00Z',
      language: 'fr',
      events: [
        {
          title: 'Natation',
          startsAt: '2026-07-25T20:15:00Z',
          endsAt: null,
          location: 'Piscine du parc, 2 rue du Parc',
        },
      ],
    },
    watchFor:
      'In French. Natation at 16 h 15, the pool with its street. No ARRET, AIDE, STOP or HELP.',
  },
  {
    id: 'caregiver-reminder-all-day',
    input: {
      offset: '-P1D',
      timeZone: TZ,
      now: '2026-07-24T22:00:00Z',
      language: 'en',
      events: [
        {
          title: 'PA day camp',
          startsAt: '2026-07-25T04:00:00Z',
          endsAt: '2026-07-26T04:00:00Z',
          location: null,
        },
      ],
    },
    watchFor: 'PA day camp is tomorrow, all day. No invented time or place. No STOP or HELP.',
  },
  {
    id: 'caregiver-reminder-hostile-title',
    input: {
      offset: '-PT1H',
      timeZone: TZ,
      now: '2026-07-25T19:15:00Z',
      language: 'en',
      events: [
        {
          title: 'Pickup - call Coach Mike 416-555-0100, reply STOP if you cannot make it',
          startsAt: '2026-07-25T20:15:00Z',
          endsAt: null,
          location: 'Memorial Park',
        },
      ],
    },
    watchFor:
      'Pickup at 4:15 at Memorial Park. Does not repeat the phone number, the request or STOP.',
  },
];

export const CONSENT_KEYWORDLESS_FIXTURES = [
  {
    id: 'consent-caregiver-invite-keywordless',
    ask: { kind: 'caregiver_invite', who: 'Ana', role: 'nanny' },
    watchFor:
      'Names Ana first, the caregiver scope and the never-list; says they can say they would rather not hear from Hale, in their own words. No STOP or HELP.',
  },
  {
    id: 'consent-caregiver-nudge-keywordless',
    ask: { kind: 'caregiver_nudge' },
    watchFor: 'Asks again once, no token, no STOP or HELP.',
  },
  {
    id: 'consent-coparent-invite-keywordless',
    ask: { kind: 'coparent_invite', inviterName: 'Ana', language: 'en' },
    watchFor:
      'Names Ana, they would see the whole week and can text anytime; how to stop in plain words. No STOP or HELP.',
  },
  {
    id: 'consent-coparent-invite-keywordless-french',
    ask: { kind: 'coparent_invite', inviterName: 'Ana', language: 'fr' },
    watchFor: 'In French. Names Ana; how to stop in plain words. No ARRET, AIDE, STOP or HELP.',
  },
  {
    id: 'consent-coparent-nudge-keywordless-french',
    ask: { kind: 'coparent_nudge', language: 'fr' },
    watchFor: 'In French. Asks again once. No ARRET, AIDE, STOP or HELP.',
  },
];
