/**
 * VIL-442 (T15) judge cases. Meaning, not wording. A 1–5 score.
 *
 * The runner does not assert a phrase. The judge scores whether the reading
 * or the spoken line matches the situation.
 */

export const GROUP_PLAN_RSVP_READ_FIXTURES = [
  {
    id: 'picnic-start',
    situation: 'A parent asks Hale, in their own words, to keep count for a Saturday picnic.',
    input: {
      text: 'Hale can you keep track of who is coming to the picnic Saturday?',
      tapback: null,
      senderName: 'Priya',
      plan: null,
      recent: [],
    },
    accept: ['start_tracking'],
  },
  {
    id: 'family-yes',
    situation: 'A parent answers for their whole household on a live museum plan.',
    input: {
      text: 'the Chens are in, all three of us',
      tapback: null,
      senderName: 'Maya',
      plan: {
        title: 'ROM Saturday',
        deadline: 'Friday',
        yesNames: [],
        waitingNames: ['Maya', 'Wei', 'Sam'],
      },
      recent: [],
    },
    accept: ['rsvp'],
  },
  {
    id: 'edit-no',
    situation: 'Someone who already said yes changes their mind.',
    input: {
      text: 'actually we cannot make it',
      tapback: null,
      senderName: 'Maya',
      plan: {
        title: 'Saturday picnic',
        deadline: null,
        yesNames: ['Maya'],
        waitingNames: ['Sam'],
      },
      recent: [],
    },
    accept: ['edit', 'rsvp'],
  },
  {
    id: 'ask-count',
    situation: 'Someone wants the live yes / no / waiting picture.',
    input: {
      text: 'where do we stand',
      tapback: null,
      senderName: 'Priya',
      plan: {
        title: 'Saturday picnic',
        deadline: null,
        yesNames: ['Sam'],
        waitingNames: ['Maya'],
      },
      recent: [],
    },
    accept: ['ask_tally'],
  },
  {
    id: 'banter',
    situation: 'People joking with each other. Not a vote and not an ask.',
    input: {
      text: 'lol remember last time with the wasps',
      tapback: null,
      senderName: 'Maya',
      plan: {
        title: 'Saturday picnic',
        deadline: null,
        yesNames: ['Sam'],
        waitingNames: ['Maya'],
      },
      recent: [],
    },
    accept: ['chatter'],
  },
];

export const GROUP_PLAN_RSVP_VOICE_FIXTURES = [
  {
    id: 'tally-report',
    kind: 'tally',
    situation:
      'Hale is reporting the live count for a Saturday picnic. Facts: 2 yes (Priya, Sam), 1 no (Maya), 1 waiting (Dev), deadline Friday. No question.',
    watchFor:
      'Must carry the yes / no / waiting picture and the deadline from facts. Must not invent a calendar write, a poll, or a reply keyword.',
  },
  {
    id: 'follow-up',
    kind: 'follow_up',
    situation:
      'Hale is nudging the people still waiting on soccer Saturday. Facts: waitingNames Ben. One question.',
    watchFor:
      'Must name who is waiting from facts. One ask. Must not invent that Ben is free or busy.',
  },
];
