// The group voice — the corpus.
//
// Every line Hale says in the Linq household group (both parents and Hale) is written by
// the model from real facts (packages/agent/skills/group-voice.md). There is no fixed
// sentence underneath any of these: what the model writes is what both parents read, or
// nothing goes out and #ops is paged. So the corpus is built around the two ways that fails.
//
//   · Every fixture must produce a line the REAL judge accepts
//     (apps/web/lib/channel/voice/judge.ts, loaded live): inside the length cap, exactly
//     the asked number of questions with the question last, every mustMention string
//     carried, no time / weekday / price / URL / phone the facts did not hand over, no
//     compliance or keyword-reply wording, vous and real accents in French, and no claim
//     that Hale booked anything. A beautiful line that trips the judge is a line two
//     parents never get.
//
//   · Every fixture must also be the RIGHT line for the moment — the per-kind direction
//     in the skill, scored by the judge model with `watchFor` as the fixture's notes.
//
// `request` is the exact GroupLineRequest the web app builds; `groupLineInput` (loaded
// live from apps/web/lib/channel/linq/group-line-input.ts) turns it into what the model
// sees, so a change to the facts a kind hands over re-keys the cache here.

export const GROUP_VOICE_FIXTURES = [
  {
    id: 'welcome-en',
    language: 'en',
    request: { kind: 'welcome' },
    parentWords: 'hi there',
    watchFor:
      'The second parent just appeared. One clause that this is Hale and this thread is the kids year for both of them, then ONE question: what to call them. Must not ask for a postal code, ages, or a child name. Must not describe a name card.',
  },
  {
    id: 'member-welcome-fr',
    language: 'fr',
    request: { kind: 'member_welcome', adder: 'Barton' },
    parentWords: null,
    watchFor:
      'French, vous. Names Barton as the one who added them. One question: comment vous appeler. Real accents, no ASCII stand-ins. No keyword to type.',
  },
  {
    id: 'stranger-hold-en',
    language: 'en',
    request: { kind: 'stranger_hold', parentA: 'Barton' },
    parentWords: 'hey what is this',
    watchFor:
      'Asks Barton by name whether this person shares the load and should be in. Must not quote "hey what is this", must not name or describe the newcomer, must say nothing about the family. One question only.',
  },
  {
    id: 'name-ack-en',
    language: 'en',
    request: { kind: 'name_ack', name: 'Sam' },
    parentWords: 'Sam',
    watchFor:
      'A one-line receipt that Hale will call them Sam. No question at all. Must not ask about a calendar or anything else next.',
  },
  {
    id: 'calendar-ask-en',
    language: 'en',
    request: { kind: 'calendar_ask', name: 'Sam' },
    parentWords: 'ready',
    watchFor:
      'For Sam. One question: whether they want their calendar in the kids year too. Says the link is just for them; may say "this link" because code appends the URL. Must not write a URL. Must not mention Gmail. Must not say Hale will change their events.',
  },
  {
    id: 'calendar-receipt-fr',
    language: 'fr',
    request: { kind: 'calendar_receipt', name: 'Sam' },
    parentWords: null,
    watchFor:
      'French, vous. Sam\'s calendar is connected and Hale will keep the kids things straight across both calendars. No question. Must not name an event, must not mention Gmail, must not say anything is booked.',
  },
  {
    id: 'gmail-ask-en',
    language: 'en',
    request: { kind: 'gmail_ask', name: 'Sam' },
    parentWords: 'done',
    watchFor:
      'For Sam. One question: whether they want Hale to catch school and camp emails too. Says the link is just for them and nothing from their inbox shows up in this thread. Must not mention the calendar. Must not write a URL.',
  },
  {
    id: 'gmail-receipt-en',
    language: 'en',
    request: { kind: 'gmail_receipt', name: 'Sam' },
    parentWords: null,
    watchFor:
      'Sam\'s Gmail is connected: Hale will pull out the kids dates and the inbox stays private. No question. Must not quote a subject, a sender, or any mailbox content.',
  },
  {
    id: 'kid-event-two-en',
    language: 'en',
    request: {
      kind: 'kid_event',
      events: [
        { parent: 'Barton', kid: 'Maya', event: 'Swim level 2', day: 'Saturday', time: '9:00' },
        { parent: 'Barton', kid: 'Leo', event: 'Soccer', day: 'Saturday', time: '11:00' },
      ],
    },
    parentWords: null,
    watchFor:
      'A heads-up to the other parent that Barton added two things: Maya, Swim level 2, Saturday 9:00 and Leo, Soccer, Saturday 11:00. Every kid, title, day and time as given. No question. Must not say Hale booked or added them. Must not add a third event, a place, or a thing to bring.',
  },
  {
    id: 'kid-event-fr',
    language: 'fr',
    request: {
      kind: 'kid_event',
      events: [{ parent: 'Sam', kid: 'Maya', event: 'Natation', day: 'samedi', time: '9 h' }],
    },
    parentWords: null,
    watchFor:
      'French, vous, real accents. Sam added Natation for Maya, samedi at 9 h. No question. Must not say Hale booked or added it.',
  },
  {
    id: 'conflict-en',
    language: 'en',
    request: { kind: 'conflict', kid: 'Maya', event: 'Swim level 2', day: 'Saturday', time: '9:00' },
    parentWords: null,
    watchFor:
      'Maya has Swim level 2 Saturday at 9:00 and both parents are busy then. Says that plainly, then ONE question: who is taking it. Must not pick a parent, must not suggest cancelling, must not describe a poll.',
  },
  {
    id: 'who-takes-fr',
    language: 'fr',
    request: { kind: 'who_takes', kid: 'Maya', event: 'Natation', day: 'samedi', time: '9 h' },
    parentWords: null,
    watchFor:
      'French, vous. Nobody has said who takes Maya to Natation samedi at 9 h. Must NOT say there is a clash or that anyone is busy. One question: who is taking it. Must not pick a parent.',
  },
  {
    id: 'handoff-en',
    language: 'en',
    request: { kind: 'handoff', name: 'Sam', kid: 'Maya', event: 'Swim level 2', time: '9:00' },
    parentWords: null,
    watchFor:
      'Tomorrow Sam has Maya\'s Swim level 2 at 9:00. A short reminder to both naming Sam, Maya, Swim level 2, 9:00 and the word tomorrow. No question. Must not add a location, a thing to bring, or a weekday name.',
  },
  {
    id: 'how-it-went-named-en',
    language: 'en',
    request: { kind: 'how_it_went', name: 'Sam', activity: 'gymnastics' },
    parentWords: null,
    watchFor:
      'One warm question to Sam by name about how gymnastics went. Must not assume it happened or went well, must not offer to do anything next, must not add a time or a place. Under 200 characters.',
  },
  {
    id: 'how-it-went-unnamed-fr',
    language: 'fr',
    request: { kind: 'how_it_went', name: null, activity: 'la gymnastique' },
    parentWords: null,
    watchFor:
      'French, vous, to both parents (no name is known - must not invent one). One question about how la gymnastique went. Nothing assumed, nothing offered.',
  },
  {
    id: 'both-free-en',
    language: 'en',
    request: { kind: 'both_free', slots: ['Sat Oct 10 9:00-10:30', 'Sun Oct 11 14:00-15:30'] },
    parentWords: 'when are we both free',
    watchFor:
      'Says they are both free at exactly these two windows, both named as given. ONE question: whether they want the sign-up page for one of them. Must not add a third slot, must not say anything is booked, must not tell them to reply with a number.',
  },
  {
    id: 'decision-sync-three-en',
    language: 'en',
    request: {
      kind: 'decision_sync',
      decisions: [
        {
          parent: 'Barton',
          decision: 'picked',
          activity: 'swim',
          kid: 'Maya',
          day: 'Tuesday',
          time: '4 pm',
        },
        { parent: null, decision: 'passed', activity: 'piano', kid: 'Maya', day: null, time: null },
        { parent: 'Sam', decision: 'duty', activity: 'soccer', kid: 'Leo', day: 'Saturday', time: '9:00' },
      ],
    },
    parentWords: null,
    watchFor:
      'A quick sync so the other parent knows: Barton picked swim for Maya, Tuesday 4 pm; one of you passed on piano for Maya (no name known - must say "one of you" or similar, not invent a name, and give no day or time); Sam will take soccer for Leo Saturday 9:00. No question. Must not say anything is booked or registered.',
  },
  {
    id: 'decision-sync-picked-fr',
    language: 'fr',
    request: {
      kind: 'decision_sync',
      decisions: [
        { parent: 'Barton', decision: 'picked', activity: 'natation', kid: 'Maya', day: 'mardi', time: '16 h' },
      ],
    },
    parentWords: null,
    watchFor:
      'French, vous, real accents. Barton a choisi natation pour Maya, mardi 16 h. No question. Must not say anything is réservé or inscrit.',
  },
  {
    id: 'departure-group-en',
    language: 'en',
    request: { kind: 'departure', name: 'Sam' },
    parentWords: null,
    watchFor:
      'Sam left Hale. Plainly: Sam left, nothing in the kids year changed, Hale is still here. No question. No guilt, no reason, no detail about why, no asking them to come back.',
  },
  {
    id: 'departure-1to1-fr',
    language: 'fr',
    request: { kind: 'departure', name: null, address: 'tu' },
    parentWords: null,
    watchFor:
      'A 1:1 line in French, so TU (ton coparent), never vous. No name is known - says the other parent / ton coparent without inventing one. They left Hale, nothing changed for the kids, Hale is still here. No question.',
  },
  {
    id: 'empty-saturday-en',
    language: 'en',
    request: { kind: 'empty_saturday', name: 'Sam', kid: 'Maya' },
    parentWords: null,
    watchFor:
      'To Sam: Saturday looks open for Maya. ONE question: whether they want one nearby find that is actually running that day. Must not name an activity, a place, or a time. Must not say Hale booked anything.',
  },
  {
    id: 'empty-saturday-both-fr',
    language: 'fr',
    request: { kind: 'empty_saturday', name: null, kid: 'Maya' },
    parentWords: null,
    watchFor:
      'French, vous, to both parents (no name known). Samedi looks open for Maya. One question: whether they want one nearby find that is running that day. No activity, place, or time named.',
  },
];
