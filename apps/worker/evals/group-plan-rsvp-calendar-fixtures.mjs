// VIL-503 · reader and voice situations. The runner does not match words or enums.
// A judge reads each situation against the model's answer.

const PICNIC = {
  title: 'Saturday picnic',
  startsAt: '2026-11-01T16:00:00.000Z',
  location: 'the park',
  displayName: 'Priya',
  householdLabel: 'the Patels',
};

export const READER_FIXTURES = [
  {
    id: 'one-parent-ok',
    input: {
      text: 'Yes, put the picnic on our calendar',
      tapback: null,
      senderName: 'Priya',
      consent: 'asked',
      ask: PICNIC,
    },
    situation:
      'Priya was asked, in private, whether to put Saturday picnic on the Patel household calendar. She agrees to that calendar add. The ask is still open. This is a clear yes to the calendar from the parent who was asked.',
  },
  {
    id: 'coparent-no-other-still-yes',
    input: {
      text: 'I cannot make the picnic, but Priya is still coming',
      tapback: null,
      senderName: 'Sam',
      consent: 'asked',
      ask: PICNIC,
    },
    situation:
      'Sam, the co-parent, says he is not coming. Priya, who was asked about the calendar, is still a yes for the picnic. The open question is only whether the picnic goes on the household calendar. This message is about who is coming, not about that calendar add. It is not a refusal of the calendar and not an agreement to put the plan on it.',
  },
  {
    id: 'tapback-on-the-ask',
    input: {
      text: '',
      tapback: 'love',
      senderName: 'Priya',
      consent: 'asked',
      ask: { ...PICNIC, householdLabel: null },
    },
    situation:
      'The turn is only a heart on the open private calendar ask. There is no text. A heart on that ask is a clear yes to put the plan on the calendar. A laugh, an emphasize, or a question mark would not be.',
  },
  {
    id: 'tapback-thumbs-down',
    input: {
      text: '',
      tapback: 'dislike',
      senderName: 'Priya',
      consent: 'asked',
      ask: { ...PICNIC, householdLabel: null },
    },
    situation:
      'The turn is only a thumbs-down on the open private calendar ask. There is no text. A thumbs-down on that ask is a clear no to the calendar add.',
  },
  {
    id: 'tapback-laugh',
    input: {
      text: '',
      tapback: 'laugh',
      senderName: 'Priya',
      consent: 'asked',
      ask: { ...PICNIC, householdLabel: null },
    },
    situation:
      'The turn is only a laugh on the open private calendar ask. A laugh is not a yes and not a no. It does not decide the calendar add.',
  },
  {
    id: 'still-coming-not-a-reopen',
    input: {
      text: 'We are still coming',
      tapback: null,
      senderName: 'Priya',
      consent: 'declined',
      ask: PICNIC,
    },
    situation:
      'The household already declined the calendar add. Priya says they are still coming. She does not bring the calendar add back up. This is about attendance, so it is not a request to ask again about the calendar.',
  },
];

export const VOICE_FIXTURES = [
  {
    id: 'fr-ask',
    kind: 'calendar_ask',
    language: 'fr',
    facts: {
      title: 'pique-nique de samedi',
      startsAt: '2026-11-01T16:00:00.000Z',
      location: 'le parc',
      displayName: 'Priya',
      householdLabel: 'les Patel',
    },
    situation:
      'One private line to Priya, in French, the way a friend texts. Ask whether to put this picnic on her household calendar. One real question. Address her, not the group. Do not invent a fact. Do not use a fixed phrase.',
  },
  {
    id: 'zh-written',
    kind: 'calendar_written',
    language: 'zh',
    facts: {
      title: '周六野餐',
      startsAt: '2026-11-01T16:00:00.000Z',
      location: '公园',
      displayName: 'Priya',
      householdLabel: null,
    },
    situation:
      'One private line to Priya, in Chinese, the way a friend texts. The picnic is now on her calendar. No question. Do not say it was added for anyone else, and do not claim to see her other events. Do not use a fixed phrase.',
  },
];
