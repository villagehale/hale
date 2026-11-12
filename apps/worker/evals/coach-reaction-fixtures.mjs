// VIL-680 · the model chooses the tapback on a parent's 1:1 iMessage chat.
//
// Each case is one text with LINQ_REACTIONS_ENABLED lit. `expect` is where the REAL
// `planParentReaction` must land on the model's choice: 'alone' (the tapback is the whole
// answer), 'not_alone' (the words go, with or without a tapback), or 'any' (only the judge
// grades it). `situation` is what the judge reads; it never names an emoji. Families,
// places and times are fictional, and no child is named (the repo is public).

export const COACH_REACTION_NOW = '2026-11-12T17:00:00.000Z';

export const COACH_REACTION_CHILD = {
  id: 'child-preschool',
  stage: 'preschool',
  name: null,
  ageMonths: 50,
  teenRedacted: false,
};

const SWIM = {
  id: 'evt-swim',
  title: 'Swim lesson',
  startsAt: '2026-11-14T15:00:00.000Z',
  endsAt: '2026-11-14T15:45:00.000Z',
  location: 'Community pool',
};

/** The parent's own watch on a full class, for the case that ends it. */
export const COACH_REACTION_WATCH = {
  id: 'watch-1',
  label: 'Saturday swim',
  host: 'rec.example.test',
};

const ASKED_SWIM = [
  { role: 'user', content: 'what time is swim on saturday?' },
  { role: 'assistant', content: 'Swim is Saturday at 10 at the Community pool.' },
];

export const COACH_REACTION_FIXTURES = [
  {
    id: 'thanks-en',
    earlier: ASKED_SWIM,
    text: 'thanks so much!',
    events: [SWIM],
    expect: 'alone',
    situation: 'The parent got the answer they asked for and is closing the thread with thanks.',
  },
  {
    id: 'merci-fr',
    earlier: [
      { role: 'user', content: 'à quelle heure est la natation samedi ?' },
      { role: 'assistant', content: 'La natation est samedi à 10 h à la piscine communautaire.' },
    ],
    text: 'parfait, merci !',
    events: [SWIM],
    expect: 'alone',
    situation: 'In French, the parent got their answer and is closing the thread with thanks.',
  },
  {
    id: 'xiexie-zh',
    earlier: [
      { role: 'user', content: '周六游泳几点？' },
      { role: 'assistant', content: '周六上午10点，在社区游泳池。' },
    ],
    text: '好的，谢谢！',
    events: [SWIM],
    expect: 'alone',
    situation: 'In Chinese, the parent got their answer and is closing the thread with thanks.',
  },
  {
    id: 'shukran-ar',
    earlier: [
      { role: 'user', content: 'متى درس السباحة يوم السبت؟' },
      { role: 'assistant', content: 'درس السباحة يوم السبت الساعة 10 صباحًا في المسبح المجتمعي.' },
    ],
    text: 'شكرا جزيلا',
    events: [SWIM],
    expect: 'alone',
    situation: 'In Arabic, the parent got their answer and is closing the thread with thanks.',
  },
  {
    id: 'ok-thumbs',
    earlier: [
      { role: 'user', content: 'is swim still at 10 this saturday?' },
      {
        role: 'assistant',
        content: 'It moved to 10:30 this Saturday, same pool. Everything else is the same.',
      },
    ],
    text: 'ok 👍',
    events: [{ ...SWIM, startsAt: '2026-11-14T15:30:00.000Z', endsAt: '2026-11-14T16:15:00.000Z' }],
    expect: 'alone',
    situation: 'Hale told the parent about a time change; the parent acknowledges it.',
  },
  {
    id: 'see-you-then',
    earlier: [
      { role: 'user', content: 'can we do the library story time saturday at 11 after swim?' },
      {
        role: 'assistant',
        content: 'Yes, story time is at 11 and swim ends at 10:45, so there is time to walk over.',
      },
    ],
    text: 'perfect, see you then!',
    events: [SWIM],
    expect: 'any',
    situation: 'A plan the parent is happy with is settled; they are signing off warmly.',
  },
  {
    id: 'good-news',
    earlier: [],
    text: 'she rode her bike without training wheels today!!',
    events: [SWIM],
    expect: 'any',
    situation: 'The parent is sharing a proud moment about their child.',
  },
  {
    id: 'question-in-thanks',
    earlier: ASKED_SWIM,
    text: 'thanks! do I need to bring a towel or do they have them?',
    events: [SWIM],
    expect: 'not_alone',
    situation:
      'The parent thanks Hale but also asks a question; Hale may not know the answer and must say so in words.',
  },
  {
    id: 'cancel-reminder',
    earlier: ASKED_SWIM,
    text: 'can you cancel the reminder for it',
    events: [SWIM],
    expect: 'not_alone',
    situation:
      'The parent asks Hale to cancel a reminder. In this chat Hale has no way to cancel one, so nothing was cancelled, and a tapback alone would read as done.',
  },
  {
    id: 'hurt-wrist',
    earlier: [],
    text: 'she fell off the climber at the park and hurt her wrist, she is still crying',
    events: [SWIM],
    expect: 'not_alone',
    situation: 'The child is hurt and upset, and the parent is worried.',
  },
  {
    id: 'complaint',
    earlier: [
      { role: 'user', content: 'what time is swim on saturday?' },
      { role: 'assistant', content: 'Swim is Saturday at 9 at the Community pool.' },
    ],
    text: 'you told me 9 but it was at 10, we sat there for an hour',
    events: [SWIM],
    expect: 'not_alone',
    situation: 'The parent is annoyed because Hale gave them the wrong time.',
  },
  {
    id: 'find-request',
    earlier: [],
    text: 'can you find us something fun to do saturday afternoon?',
    events: [SWIM],
    expect: 'not_alone',
    situation: 'The parent asks Hale to find an activity; any answer needs words.',
  },
  {
    id: 'stop-watching',
    earlier: [],
    text: 'we got a spot! you can stop watching saturday swim',
    events: [SWIM],
    watching: true,
    expect: 'not_alone',
    situation:
      'Hale was watching a full class for an opening; the parent got in and asks Hale to stop, and Hale stopped the watch.',
  },
];

/**
 * Hand-written outcomes the judge must score correctly before any case counts: known-bad
 * ones must fail and known-good ones must pass, or the scores below mean nothing.
 */
export const COACH_REACTION_JUDGE_CALIBRATION = [
  {
    id: 'cal-cancel-like-alone',
    fixture: 'cancel-reminder',
    reply: "I can't cancel reminders from here, so that one is still on your phone.",
    tapback: 'like',
    sent: 'tapback_only',
    expect: 'fail',
  },
  {
    id: 'cal-hurt-laugh',
    fixture: 'hurt-wrist',
    reply:
      "Oh no, poor thing. Keep it still and put something cold on it. If it swells or she won't move it, get it checked today.",
    tapback: 'laugh',
    sent: 'tapback_and_reply',
    expect: 'fail',
  },
  {
    id: 'cal-thanks-love-alone',
    fixture: 'thanks-en',
    reply: 'Anytime!',
    tapback: 'love',
    sent: 'tapback_only',
    expect: 'pass',
  },
  {
    id: 'cal-hurt-words-only',
    fixture: 'hurt-wrist',
    reply:
      "Oh no, poor thing. Keep it still and put something cold on it. If it swells or she won't move it, get it checked today.",
    tapback: null,
    sent: 'reply_only',
    expect: 'pass',
  },
];

/** The known-bad stand-in for `--broken`: a thumbs-up as the whole answer, on every case. */
export const COACH_REACTION_BROKEN_CHOICE = { reaction: 'like', alone: true };
