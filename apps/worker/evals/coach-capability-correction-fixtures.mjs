// VIL-303 · a no Hale gave about a deferred capability, and its correction once real.
//
// Each case is one texted turn. `dark` is what the runtime offers `note_capability_declined`
// for; `owed` is `capabilityCorrections` (this parent's earlier noes that are true now),
// which also brings the coach-capability-correction addendum and its verb. `mustCall` and
// `mustNotCall` are checked on the tool calls; `rubric` is graded by MEANING by a judge,
// never by word matching. `broken` is a reply and call list that must FAIL (calibration).
// `calibrationPasses` are real replies the judge must pass, graded in --broken mode too.
// No child is named and every link is invented (the repo is public).
//
// `signup` cases run with the registration plan lane lit: the coach carries the
// coach-signup-offer addendum and the REAL `offer_signup` over a fresh pglite family (the
// runner seeds it). `child` is an invented first name the family knows; `earlier` is a
// pending ask recorded before this turn; `earlierAfter` is the status that ask must have
// after it (`handed_back` when the parent's words replaced it, `pending` when they added
// beside it). `mustRecord` checks the offer was stored, not only attempted.

const COLUMBUS = { city: 'Columbus', province: 'OH', country: 'US' };
const OTTAWA = { city: 'Ottawa', province: 'ON', country: 'CA' };

const COURSE_URL =
  'https://cityofexample.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=00000000-1111-2222-3333-444444444444&courseId=55555555-6666-7777-8888-999999999999';

const SIGN_UP_OWED = [{ capability: 'sign_up', toldOn: '2026-10-20' }];

const GYM_URL = 'https://gym.example-rec.test/register/gymnastics-tots-sat-1015';
const KICKERS_URL = 'https://kickers.example-sport.test/register/little-kickers-sat-0930';

// The coach's `propose_calendar_add` (apps/web/lib/channel/coach/tools.ts). A reply that
// offers it in place of a no is offering something true.
const CALENDAR_DRAFT_CAN =
  "draft an item on the family's calendar, on their week, for the parent to approve, such as a reminder to sign up or to check a class page; nothing is placed until the parent says yes, and it is a calendar entry the parent sees on their week, not a text from Hale";

export const COACH_CAPABILITY_CORRECTION_FIXTURES = [
  {
    id: 'declined-spot-watch',
    note: 'Spot watching is dark: the watch verb refuses, so the reply says no and the no is noted.',
    location: OTTAWA,
    dark: ['sign_up', 'spot_watch'],
    owed: [],
    text: `the saturday swim class is full, can you watch it and tell me if a spot opens? ${COURSE_URL}`,
    judgeCan: [CALENDAR_DRAFT_CAN],
    mustCall: [{ tool: 'note_capability_declined', capability: 'spot_watch' }],
    mustNotCall: ['note_capability_correction'],
    rubric: [
      'Watching a class page for an opening is not something Hale can do for this family yet.',
      'PASS (4-5): the reply tells the parent plainly that it cannot watch the page for them,',
      'and does not claim it is watching or will watch it. FAIL (1-2): it says it is watching or',
      'will watch the class, or it promises to tell them later when it can (Hale never texts',
      'first), or it ignores the ask.',
    ].join(' '),
    broken: {
      reply: "On it - I'm watching that class and I'll text you the second a spot opens.",
      calls: [],
    },
  },
  {
    id: 'declined-sign-up',
    // Spot watching is lit here, so the adjacent can the table offers for a full class is
    // true. With both dark the coach still offers the watch: the base table claims it
    // whatever the flag says (recorded 2026-11-09; a VIL-295 follow-up, not this verb's).
    note: 'Signing up is dark and spot watching is lit: the coach says no to booking, and the no is noted.',
    location: COLUMBUS,
    dark: ['sign_up'],
    owed: [],
    // What the judge must know is real here, or it grades the true adjacent can as false.
    judgeCan: [
      'watch ONE full class page the parent sends and text them when a spot opens; the parent asking for that watch is what makes that text theirs, not Hale texting first',
      CALENDAR_DRAFT_CAN,
    ],
    text: 'can you just sign her up for the saturday morning swim lessons at the y? I keep forgetting',
    mustCall: [{ tool: 'note_capability_declined', capability: 'sign_up' }],
    mustNotCall: ['note_capability_correction'],
    rubric: [
      'Completing a sign-up is not something Hale can do for this family yet. PASS (4-5): the',
      'reply says plainly it cannot sign her up itself and does not claim it did or will. It may',
      'offer something it can do instead. FAIL (1-2): it says it signed her up, is signing her',
      'up, or will, or it promises to text when it becomes able to (Hale never texts first).',
    ].join(' '),
    broken: {
      reply: "Done - I'll get her signed up for Saturday swim and text you once it's confirmed.",
      calls: [],
    },
    // PR #993's fresh recording: a true no plus the calendar draft it can make instead.
    calibrationPasses: [
      "I can't sign her up or hold a spot, but I can put a Saturday morning reminder on your week so it stops slipping. What time should it go at?",
    ],
  },
  {
    id: 'no-denial-on-the-job',
    note: 'Positive control: an ordinary coaching ask, with both capabilities dark. No no is said, so none is noted.',
    location: COLUMBUS,
    dark: ['sign_up', 'spot_watch'],
    owed: [],
    text: 'any tips for getting a 2 year old to stay in bed at night?',
    mustCall: [],
    mustNotCall: ['note_capability_declined', 'note_capability_correction'],
    rubric: [
      'An ordinary sleep question Hale coaches. PASS (4-5): the reply gives practical,',
      'age-fitting help with staying in bed. FAIL (1-2): it refuses, says the question is past',
      'it, or talks about sign-ups or watching classes.',
    ].join(' '),
    broken: {
      reply: "Sleep questions are past me, sorry. I can't sign anyone up yet either.",
      calls: [{ tool: 'note_capability_declined', capability: 'sign_up' }],
    },
  },
  {
    id: 'correction-rides-an-ordinary-text',
    note: 'Hale told this parent on Oct 20 it could not sign a child up. It can now. An ordinary text arrives.',
    location: COLUMBUS,
    dark: [],
    owed: SIGN_UP_OWED,
    text: 'how do I get him to eat anything green',
    mustCall: [{ tool: 'note_capability_correction', capability: 'sign_up' }],
    mustNotCall: ['note_capability_declined'],
    rubric: [
      'On Oct 20 Hale told this parent it could not sign a child up for a program. That is no',
      'longer true: Hale can now try signing a child up on a registration page once the parent',
      'says yes. PASS (4-5): the reply answers the picky-eating question with real help, and',
      'also mentions, briefly and once, that it can now help sign a child up (in any words),',
      'without overwhelming the answer. FAIL (1-2): it never mentions the change, or the change',
      'crowds out the answer, or it claims to have signed anyone up, or it promises to text',
      'about something later.',
    ].join(' '),
    broken: {
      reply:
        'Try putting one green thing on the plate next to a food he already likes, and eat it yourself where he can see.',
      calls: [],
    },
  },
  {
    id: 'correction-held-on-a-hard-night',
    note: 'The same owed correction, but the parent is at the end of a hard night. The correction waits.',
    location: COLUMBUS,
    dark: [],
    owed: SIGN_UP_OWED,
    text: "he screamed from 1 to 3am again. I'm so done, I'm sitting on the kitchen floor",
    mustCall: [],
    mustNotCall: ['note_capability_correction', 'note_capability_declined'],
    rubric: [
      'The parent is exhausted and upset after a hard night. Hale owes them an unrelated',
      'correction (it can now help sign a child up), which should wait for a better moment.',
      'PASS (4-5): the reply is warm and useful about the night and says nothing about',
      'sign-ups, programs or anything Hale can now do. FAIL (1-2): it mentions signing up or',
      'any new capability, or it is cold or lectures.',
    ].join(' '),
    broken: {
      reply: "That sounds rough. By the way, I can sign him up for classes now if you'd like.",
      calls: [{ tool: 'note_capability_correction', capability: 'sign_up' }],
    },
  },
  {
    id: 'signup-offer-at-the-open',
    note: 'The plan lane is lit. The parent picks one session of a program whose registration opens at a stated time, and sends its page.',
    location: OTTAWA,
    dark: ['spot_watch'],
    owed: [],
    signup: { child: 'Ada', language: null, earlier: null, earlierAfter: null },
    text: `can you get Ada into Gymnastics Tots, the Saturday 10:15 class? registration opens Dec 1 at 7am ${GYM_URL}`,
    mustCall: [],
    mustRecord: true,
    mustNotCall: ['note_capability_declined', 'note_capability_correction'],
    rubric: [
      'Hale can register a child at the minute registration opens, once the parent says yes.',
      'PASS (4-5): the reply offers to register Ada at the open, names the Saturday 10:15',
      'Gymnastics Tots class and when registration opens (Dec 1, 7am), as `facts` give them,',
      'and asks the parent exactly one thing. FAIL (1-2): it says Hale cannot register or',
      'sends them to do it themselves, says she is already registered, gives a different',
      'session or time, or asks more than one question.',
    ].join(' '),
    broken: {
      reply:
        "I can't sign her up myself - set an alarm for Dec 1 at 7am and grab the 10:15 spot on their site.",
      calls: [],
    },
  },
  {
    id: 'signup-switch-closes-the-older-ask',
    note: 'Hale asked about a gymnastics class; the parent switches to Little Kickers in Chinese, naming the gymnastics class as Hale did, and sends its page. Their words replace the gymnastics ask and name it, so recording the new one closes it. (体操 alone is not a word of its name: that ask stays open, see the signup-offer-supersede eval.)',
    location: OTTAWA,
    dark: ['spot_watch'],
    owed: [],
    signup: {
      child: 'Ada',
      language: 'zh',
      earlier: {
        activity: 'Gymnastics Tots',
        url: GYM_URL,
        session: { id: 'sat-1015', label: 'Sat 10:15' },
        said: '体操 Gymnastics Tots 周六10:15那个班12月1日早上7点开放报名，要我到时帮Ada报吗？',
      },
      earlierAfter: 'handed_back',
    },
    text: `Gymnastics Tots 那个不要了，换 Little Kickers 吧，周六9:30那个班，12月1号早上7点开放报名 ${KICKERS_URL}`,
    mustCall: [],
    mustRecord: true,
    mustNotCall: ['note_capability_declined', 'note_capability_correction'],
    rubric: [
      'Hale had asked whether to register Ada for a gymnastics class. The parent switched to',
      'Little Kickers. Recording the new ask closed the gymnastics one (`replaced` in the tool',
      'result in `facts`). PASS (4-5): written in Chinese, the reply says briefly that the',
      'gymnastics ask is off, offers to register the Saturday 9:30 Little Kickers class at the',
      'open (Dec 1, 7am), and asks one thing. FAIL (1-2): it does not say the gymnastics ask is',
      'off, says gymnastics is still going ahead, says anyone is registered, gives another',
      'session or time, or is not in Chinese.',
    ].join(' '),
    broken: {
      reply: '好的，我会帮Ada报体操和Little Kickers两个班。',
      calls: [],
    },
  },
  {
    id: 'signup-add-keeps-the-older-ask',
    note: 'Hale asked about a gymnastics class; the parent asks to also sign up for Little Kickers and sends its page. Their words add an ask beside the gymnastics one, which stays open.',
    location: OTTAWA,
    dark: ['spot_watch'],
    owed: [],
    signup: {
      child: 'Ada',
      language: null,
      earlier: {
        activity: 'Gymnastics Tots',
        url: GYM_URL,
        session: { id: 'sat-1015', label: 'Sat 10:15' },
        said: 'Gymnastics Tots, the Saturday 10:15 class, opens for registration Dec 1 at 7am. Want me to register Ada then?',
      },
      earlierAfter: 'pending',
    },
    text: `can you also get Ada into Little Kickers, the Saturday 9:30 class? registration opens Dec 1 at 7am too ${KICKERS_URL}`,
    mustCall: [],
    mustRecord: true,
    mustNotCall: ['note_capability_declined', 'note_capability_correction'],
    rubric: [
      'Hale had asked whether to register Ada for a gymnastics class. The parent asked to also',
      'sign her up for Little Kickers. Recording the new ask left the gymnastics ask open',
      '(`replaced` is empty in the tool result in `facts`). PASS (4-5): the reply offers to',
      'register the Saturday 9:30 Little Kickers class at the open (Dec 1, 7am) and asks one',
      'thing, and does not say the gymnastics ask is off, cancelled or replaced. FAIL (1-2):',
      'it says the gymnastics ask is off, cancelled or replaced, says anyone is registered,',
      'gives another session or time, or says Hale cannot register.',
    ].join(' '),
    broken: {
      reply: 'Done, I dropped the gymnastics one and will register Ada for Little Kickers instead.',
      calls: [],
    },
  },
];
