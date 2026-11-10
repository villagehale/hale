// VIL-495 · when the 1:1 coach says its reply as a voice memo.
//
// Each case is one turn in a parent's own iMessage chat, with LINQ_VOICE_MEMOS_ENABLED
// lit. The metric is objective and is not word matching: did the model call
// `reply_as_voice_memo`? `expectVoice` follows Sloane's Design lock (VIL-476): voice when
// the parent just sent a voice memo or asks to hear it; text for a short fact to glance
// at. `heard` is a transcript the way the coach receives one. Families, places and
// times are fictional, and no child is named (the repo is public).

export const COACH_VOICE_MEMO_CHILD = {
  id: 'child-toddler',
  stage: 'toddler',
  name: null,
  ageMonths: 30,
  teenRedacted: false,
};

const SWIM = {
  id: 'evt-swim',
  title: 'Swim lesson',
  startsAt: '2026-11-14T15:00:00.000Z',
  endsAt: '2026-11-14T15:45:00.000Z',
  location: 'Community pool',
};

export const COACH_VOICE_MEMO_FIXTURES = [
  {
    id: 'memo-how-it-went',
    text: '',
    arrivedMedia: [
      {
        kind: 'audio',
        heard:
          'Hey! So swim was amazing today, she finally put her face in the water and she was so proud of herself. Anyway, just wanted to tell you.',
      },
    ],
    events: [SWIM],
    expectVoice: true,
  },
  {
    id: 'asks-for-voice',
    text: "I'm driving, can you just send me a voice memo with what's on for us this weekend?",
    arrivedMedia: null,
    events: [SWIM],
    expectVoice: true,
  },
  {
    id: 'short-fact',
    text: 'what time is swim on saturday?',
    arrivedMedia: null,
    events: [SWIM],
    expectVoice: false,
  },
  {
    id: 'plain-thanks',
    text: 'ok thanks!',
    arrivedMedia: null,
    events: [SWIM],
    expectVoice: false,
  },
];
