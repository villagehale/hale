// The evening check-in voice — the corpus.
//
// Every word the check-in lane says to a parent — the nightly "how did today go", the
// anchored "how did swim go", the thank-you for a diary line, and the receipt that the
// rhythm changed — is written by the model from real facts
// (packages/agent/skills/checkin-voice.md). Until VIL-413 / VIL-417 this lane was a copy
// file: a pinned first ask that printed LESS and NO, a five-member pool, a locked anchored
// sentence, three cadence acks that taught DAILY, a ten-member thank-you pool, and a
// step-down notice. There is no fixed sentence underneath any of them now. What the model
// writes is what the parent reads, or nothing goes out and #ops is paged. So the corpus is
// built around the two ways that fails.
//
//   · Every fixture must produce a line the REAL judge accepts
//     (apps/web/lib/channel/voice/judge.ts, loaded live): inside the length cap, exactly
//     one question and it last on the asks and none on the acks, the kids / activity /
//     parent carried word for word, no time / weekday / price / URL / phone the facts did
//     not hand over, no compliance or keyword-reply wording, no "Noted" opener, no remark
//     on a quiet evening, tu or vous as asked with real accents in French, and no claim
//     that Hale booked anything.
//
//   · Every fixture must also be the RIGHT line for the moment — the per-kind direction
//     in the skill, scored by the judge model with `watchFor` as the fixture's notes.
//
// `request` is the exact CheckInLineRequest the sweep and the reply handler build;
// `checkInLineInput` (loaded live from apps/web/lib/channel/checkin/line-input.ts) turns it
// into what the model sees, so a change to the facts a kind hands over re-keys the cache.
// `options` is the sweep's CheckInLineOptions: the parent named in a group, the parent's
// words when the line answers a message.

export const CHECKIN_VOICE_FIXTURES = [
  // ── first_ask ────────────────────────────────────────────────────────────────
  {
    id: 'first-ask-en',
    language: 'en',
    address: 'tu',
    request: { kind: 'first_ask', kids: ['Mia', 'Leo'] },
    watchFor:
      'The very first evening question. Names Mia and Leo. Asks how today went and says one line is plenty. Makes it known in passing that they can have this less often or not at all, said as a friend would - NEVER as a word to reply with (no LESS, NO, DAILY, YES). One question, the last sentence. Must not invent anything about the day.',
  },
  {
    id: 'first-ask-fr',
    language: 'fr',
    address: 'tu',
    request: { kind: 'first_ask', kids: ['Léo'] },
    watchFor:
      'French, tu, real accents (journée, soirée). Names Léo. Asks how today went, says a line is plenty, and mentions as a friend would that they can have this less often or not at all - no keyword to type. One question, last. Never vous.',
  },
  {
    id: 'first-ask-nobody-en',
    language: 'en',
    address: 'tu',
    request: { kind: 'first_ask', kids: [] },
    watchFor:
      'No names were handed over, so it says "the kids" or "today" and names nobody. Asks how today went, one line is plenty, way out mentioned as a friend would. One question, last. No invented child name.',
  },
  {
    id: 'first-ask-group-fr',
    language: 'fr',
    address: 'vous',
    request: { kind: 'first_ask', kids: ['Mia'] },
    options: { parentName: 'Sam' },
    watchFor:
      'Lands in the household group, both parents reading: vous, and it opens by naming Sam so it is clear whose evening it is. Names Mia. One question, last. Way out mentioned as a friend would. Never tu.',
  },

  // ── later_ask ────────────────────────────────────────────────────────────────
  {
    id: 'later-ask-en',
    language: 'en',
    address: 'tu',
    request: { kind: 'later_ask', kids: ['Mia'] },
    watchFor:
      'An ordinary evening. Names Mia. Asks how today went, or what stood out, or what the best bit was; a word or two is plenty. Does NOT mention the way out this time. One question, last. Nothing about the day invented.',
  },
  {
    id: 'later-ask-fr',
    language: 'fr',
    address: 'tu',
    request: { kind: 'later_ask', kids: ['Noé', 'Mia'] },
    watchFor:
      'French, tu, real accents. Names Noé and Mia. Asks how the day went or what stood out; a word is plenty. No way out mentioned. One question, last. Never vous.',
  },
  {
    id: 'later-ask-nobody-en',
    language: 'en',
    address: 'tu',
    request: { kind: 'later_ask', kids: [] },
    watchFor:
      'Names nobody - "the kids" or "today". Asks how the day went; a word or two is plenty. No way out. One question, last.',
  },
  {
    id: 'later-ask-group-en',
    language: 'en',
    address: 'vous',
    request: { kind: 'later_ask', kids: ['Mia'] },
    options: { parentName: 'Jordan' },
    watchFor:
      "Household group: opens by naming Jordan, names Mia, asks how today went. One question, last. No way out. Does not read as if addressed to both parents at once about their own day - it is Jordan's evening.",
  },

  // ── how_it_went ──────────────────────────────────────────────────────────────
  {
    id: 'how-it-went-en',
    language: 'en',
    address: 'tu',
    request: { kind: 'how_it_went', activity: 'swim', kids: ['Mia'] },
    watchFor:
      'Hale saw "swim" on the calendar today and asks how it went, carrying "swim" word for word. May name Mia. One line is plenty. One question, last. Must not add a place, a time, a coach, a pool, or anything about how it went.',
  },
  {
    id: 'how-it-went-fr',
    language: 'fr',
    address: 'tu',
    request: { kind: 'how_it_went', activity: 'cours de natation', kids: ['Léo'] },
    watchFor:
      'French, tu, real accents. Carries "cours de natation" word for word and asks how it went. May name Léo. One question, last. No place or time invented. Never vous.',
  },
  {
    id: 'how-it-went-title-nobody-en',
    language: 'en',
    address: 'tu',
    request: { kind: 'how_it_went', activity: 'Rainbow Room PA day camp', kids: [] },
    watchFor:
      'Carries the title "Rainbow Room PA day camp" exactly as written - not shortened, not re-cased. Names no child. Asks how it went. One question, last. No invented detail.',
  },
  {
    id: 'how-it-went-group-en',
    language: 'en',
    address: 'vous',
    request: { kind: 'how_it_went', activity: 'soccer practice', kids: ['Leo'] },
    options: { parentName: 'Sam' },
    watchFor:
      'Household group: names Sam, carries "soccer practice" word for word, asks how it went. May name Leo. One question, last. No score, place or time invented.',
  },

  // ── cadence_ack ──────────────────────────────────────────────────────────────
  {
    id: 'cadence-weekly-asked-en',
    language: 'en',
    address: 'tu',
    request: { kind: 'cadence_ack', cadence: 'weekly', trigger: 'parent_asked' },
    options: { parentWords: 'less often please' },
    watchFor:
      'The parent asked for these less often. Confirms plainly that Hale will ask weekly now, one short sentence, and makes the way back known as a friend would ("say the word if you want them nightly again" is fine) - never a word to type. No question mark. Does not quote the parent. No "Noted".',
  },
  {
    id: 'cadence-off-asked-en',
    language: 'en',
    address: 'tu',
    request: { kind: 'cadence_ack', cadence: 'off', trigger: 'parent_asked' },
    options: { parentWords: 'no thanks, not for us' },
    watchFor:
      'The parent wants these gone. Confirms the evening questions stop, no bargaining, no "are you sure", and says they can text Hale any time. No question mark. No keyword. Warm, not wounded. No "Noted".',
  },
  {
    id: 'cadence-off-asked-fr',
    language: 'fr',
    address: 'tu',
    request: { kind: 'cadence_ack', cadence: 'off', trigger: 'parent_asked' },
    options: { parentWords: 'non merci, arrête de demander' },
    watchFor:
      'French, tu, real accents. Confirms the evening questions stop, no bargaining, says they can write any time. No question mark. No keyword, no STOP. Never vous.',
  },
  {
    id: 'cadence-daily-asked-fr',
    language: 'fr',
    address: 'tu',
    request: { kind: 'cadence_ack', cadence: 'daily', trigger: 'parent_asked' },
    options: { parentWords: 'tous les soirs svp' },
    watchFor:
      'French, tu, real accents. The parent asked for the nightly question back; confirms Hale will ask every evening again. No question mark. One short sentence or two. No keyword.',
  },
  {
    id: 'cadence-weekly-quiet-en',
    language: 'en',
    address: 'tu',
    request: { kind: 'cadence_ack', cadence: 'weekly', trigger: 'quiet_evenings' },
    watchFor:
      'Hale is stepping down to weekly on its own after quiet evenings. Says that is what it will do and that nightly is theirs again whenever they want it. Must NOT mention the silence, the missed replies, or anything that reads as blame or apology-fishing. No question mark. No keyword to type.',
  },
  {
    id: 'cadence-weekly-quiet-group-fr',
    language: 'fr',
    address: 'vous',
    request: { kind: 'cadence_ack', cadence: 'weekly', trigger: 'quiet_evenings' },
    options: { parentName: 'Camille' },
    watchFor:
      'Household group, French: vous, names Camille, says Hale will check in weekly from here and that nightly is theirs again whenever they want. No mention of the quiet. No question mark. Never tu.',
  },

  // ── noted_ack ────────────────────────────────────────────────────────────────
  {
    id: 'noted-kept-en',
    language: 'en',
    address: 'tu',
    request: { kind: 'noted_ack', kept: true },
    options: { parentWords: 'Long day. Park then early bed, she loved swim.' },
    watchFor:
      'Thanks them and says what the note is for: it shapes what Hale looks for next weekend. Does NOT quote, summarise or evaluate what they said (no "glad swim went well", no "sounds like a good day"). No question mark. Does not open with "Noted". No keyword.',
  },
  {
    id: 'noted-kept-fr',
    language: 'fr',
    address: 'tu',
    request: { kind: 'noted_ack', kept: true },
    options: { parentWords: 'Journée tranquille, les deux endormis tôt.' },
    watchFor:
      'French, tu, real accents. Thanks them and says it shapes what Hale looks for next weekend (fin de semaine). Does not echo or judge the day. No question mark. Does not open with "Noté". Never vous.',
  },
  {
    id: 'noted-not-kept-en',
    language: 'en',
    address: 'tu',
    request: { kind: 'noted_ack', kept: false },
    options: { parentWords: 'Rough one. Big fight with my ex about pickup again.' },
    watchFor:
      'Thanks them for telling Hale and says plainly it will not keep that one on file. Does NOT say why, does not name the subject (no ex, no fight, no pickup), does not comfort or advise. No question mark. Does not open with "Noted".',
  },
  {
    id: 'noted-kept-group-en',
    language: 'en',
    address: 'vous',
    request: { kind: 'noted_ack', kept: true },
    options: { parentName: 'Sam', parentWords: 'Good day, Leo scored at soccer.' },
    watchFor:
      'Household group: names Sam, thanks them, says it shapes what Hale looks for next weekend. Does not repeat the goal or the soccer. No question mark. No "Noted".',
  },
];
