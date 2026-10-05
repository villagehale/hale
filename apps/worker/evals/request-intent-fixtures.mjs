// Reading a parent's message for an actionable request — the corpus.
//
// Expectations are derived from the SPEC (packages/agent/skills/request-intent.md, plus
// the guards in apps/web/lib/channel/connect/request-intent-reading.ts), NOT from what the
// model happened to answer. Every `expect` is asserted against the SETTLED reading — what
// `settleRequestIntent` hands production after the verbatim, confidence and setting
// guards — because that, and not the raw JSON, is what mints a link or plans a window.
//
// CALIBRATED BOTH DIRECTIONS, in the corpus itself:
//
//   · The connect fixtures MUST read as the right account. Until VIL-413 / VIL-417 a
//     regex (`matchConnectorRequest`: a verb class, a provider noun, a negation class, a
//     status-auxiliary class) decided it; a reader that misses "hook up my gcal" or
//     "branche mon calendrier" leaves a parent asking in plain words and getting a coach
//     answer instead of a link.
//
//   · The both_free fixtures MUST read as both_free in the household group - and MUST
//     settle to other in a parent's own thread, which is the setting guard, not the model.
//
//   · The rest MUST NOT read as a request - a status question, a disconnect, a negation,
//     a report, a bare noun, a commute "drive", conversation that happens to use the word.
//     A false connect claim mints a credential link nobody asked for; the harm of a wrong
//     one is the reason the 0.7 floor exists. A reader that eagerly hears "connect" in
//     everything would pass the first group and fail these.
//
// `input` is the exact RequestIntentInput the handler builds; `requestIntentUserMessage`
// (loaded live) turns it into the user turn, so a change to what the model is told re-keys
// the cache here.

export const REQUEST_INTENT_FIXTURES = [
  // ── connect_gcal ─────────────────────────────────────────────────────────────
  {
    id: 'connect-gcal-plain-en',
    input: { message: 'can you connect my google calendar', language: 'en', setting: 'own_thread' },
    expect: 'connect_gcal',
    why: 'The plainest form of the ask.',
  },
  {
    id: 'connect-gcal-hook-up-en',
    input: { message: 'hook up my gcal', language: 'en', setting: 'own_thread' },
    expect: 'connect_gcal',
    why: 'A verb and a noun the old regex did not list. The model reads the wish, not the word.',
  },
  {
    id: 'connect-gcal-sync-please-en',
    input: {
      message: 'sync our calendar please so you can see the kids stuff',
      language: 'en',
      setting: 'own_thread',
    },
    expect: 'connect_gcal',
    why: '"sync our calendar" is a connect ask with a reason attached; the reason does not change it.',
  },
  {
    id: 'connect-gcal-group-en',
    input: { message: 'link my calendar', language: 'en', setting: 'household_group' },
    expect: 'connect_gcal',
    why: 'Setting does not gate connect asks; the handler mints for the parent who asked.',
  },
  {
    id: 'connect-gcal-fr',
    input: { message: 'connecte mon agenda', language: 'fr', setting: 'own_thread' },
    expect: 'connect_gcal',
    why: 'French, the product noun is agenda.',
  },
  {
    id: 'connect-gcal-branche-fr',
    input: {
      message: 'tu peux brancher mon calendrier google',
      language: 'fr',
      setting: 'own_thread',
    },
    expect: 'connect_gcal',
    why: 'Quebec French "brancher"; a phrasing no keyword table carried.',
  },
  {
    id: 'connect-gcal-with-aside-en',
    input: {
      message: 'ok connect my google calendar. also leo has a cold so no swim this week',
      language: 'en',
      setting: 'own_thread',
    },
    expect: 'connect_gcal',
    why: 'A connect ask and something else too is still the connect ask (the skill says so). The aside is for the coach after.',
  },

  // ── connect_gmail / connect_gdrive ───────────────────────────────────────────
  {
    id: 'connect-gmail-read-en',
    input: {
      message: 'read my gmail for the daycare emails',
      language: 'en',
      setting: 'own_thread',
    },
    expect: 'connect_gmail',
    why: 'Wanting Hale to read Gmail is wanting it connected.',
  },
  {
    id: 'connect-gmail-email-en',
    input: { message: 'can you link my email', language: 'en', setting: 'own_thread' },
    expect: 'connect_gmail',
    why: '"my email" with a link verb is the Gmail connect; the skill lists it.',
  },
  {
    id: 'connect-gmail-fr',
    input: { message: 'connecte mon gmail stp', language: 'fr', setting: 'own_thread' },
    expect: 'connect_gmail',
    why: 'French, with the texting abbreviation.',
  },
  {
    id: 'connect-gdrive-en',
    input: {
      message: 'link my google drive, the school forms are in there',
      language: 'en',
      setting: 'own_thread',
    },
    expect: 'connect_gdrive',
    why: 'Google Drive, named, with a link verb.',
  },

  // ── both_free ────────────────────────────────────────────────────────────────
  {
    id: 'both-free-week-en',
    input: {
      message: 'when are we both free this week',
      language: 'en',
      setting: 'household_group',
    },
    expect: 'both_free',
    why: 'The canonical ask, in the group.',
  },
  {
    id: 'both-free-together-en',
    input: {
      message: 'find us a time we are both off on saturday',
      language: 'en',
      setting: 'household_group',
    },
    expect: 'both_free',
    why: 'A shared open slot, in different words.',
  },
  {
    id: 'both-free-fr',
    input: {
      message: "quand est-ce qu'on est libres tous les deux cette semaine",
      language: 'fr',
      setting: 'household_group',
    },
    expect: 'both_free',
    why: 'French, in the group.',
  },
  {
    id: 'both-free-own-thread-en',
    input: { message: 'when are we both free this week', language: 'en', setting: 'own_thread' },
    expect: 'other',
    why: 'The setting guard: one parent in their own thread has nobody to be free with here. Whatever the model says, production settles this to other.',
  },

  // ── other: questions, status, capability ─────────────────────────────────────
  {
    id: 'status-connected-en',
    input: { message: 'is my calendar connected?', language: 'en', setting: 'own_thread' },
    expect: 'other',
    why: 'A status question. The coach answers it; a link is not an answer.',
  },
  {
    id: 'capability-en',
    input: { message: 'do you sync with google calendar', language: 'en', setting: 'own_thread' },
    expect: 'other',
    why: 'Whether it is possible is not a wish to do it now.',
  },
  {
    id: 'whats-on-en',
    input: { message: "what's on the calendar saturday", language: 'en', setting: 'own_thread' },
    expect: 'other',
    why: 'A question about what is ON the calendar.',
  },
  {
    id: 'bare-noun-en',
    input: { message: 'calendar', language: 'en', setting: 'own_thread' },
    expect: 'other',
    why: 'A bare noun is not a request; the skill says so.',
  },

  // ── other: disconnect, negation, report, conversation ────────────────────────
  {
    id: 'disconnect-en',
    input: { message: 'unlink my google calendar', language: 'en', setting: 'own_thread' },
    expect: 'other',
    why: 'Another reader owns the undo. A connect claim on a disconnect ask hands a parent a link they did not want.',
  },
  {
    id: 'stop-reading-gmail-fr',
    input: { message: 'arrête de lire mon gmail', language: 'fr', setting: 'own_thread' },
    expect: 'other',
    why: 'A stop, in French.',
  },
  {
    id: 'negation-en',
    input: {
      message: "please don't connect my calendar, I'd rather type things in",
      language: 'en',
      setting: 'own_thread',
    },
    expect: 'other',
    why: 'A negation with the verb and the noun both present. The old regex had a negation class; the model reads the sentence.',
  },
  {
    id: 'report-en',
    input: {
      message: 'I connected my calendar yesterday, did it work',
      language: 'en',
      setting: 'own_thread',
    },
    expect: 'other',
    why: 'A report plus a status question.',
  },
  {
    id: 'conversation-connect-en',
    input: {
      message: "let's connect after I check the calendar tonight",
      language: 'en',
      setting: 'own_thread',
    },
    expect: 'other',
    why: '"connect" meaning talk, and "calendar" meaning look at it.',
  },
  {
    id: 'commute-drive-en',
    input: {
      message: 'the drive to swim is 40 min, can you find something closer',
      language: 'en',
      setting: 'own_thread',
    },
    expect: 'other',
    why: '"drive" is a commute, and the request is for the finder. Never connect_gdrive.',
  },
  {
    id: 'someone-elses-account-en',
    input: {
      message: 'my mom wants to connect her calendar too, can she',
      language: 'en',
      setting: 'own_thread',
    },
    expect: 'other',
    why: "Someone else's account. The coach explains; this parent gets no link.",
  },
  {
    id: 'fresh-link-no-account-en',
    input: { message: 'the link expired, send a new one', language: 'en', setting: 'own_thread' },
    expect: 'other',
    why: 'No account named: code reads the prior offer for a fresh link. The skill routes this to other.',
  },
  {
    id: 'greeting-en',
    input: { message: 'hey', language: 'en', setting: 'household_group' },
    expect: 'other',
    why: 'Nothing asked.',
  },
];
