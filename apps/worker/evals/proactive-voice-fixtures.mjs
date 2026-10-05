// The proactive 1:1 voice — the corpus.
//
// The two asks Hale texts one parent unprompted — an open Saturday, and the weekday-care
// finder ask — are written by the model from real facts
// (packages/agent/skills/proactive-voice.md). Until VIL-413 / VIL-417 both were byte-locked
// sentences; now there is no fixed sentence underneath either. What the model writes is
// what the parent reads, or nothing goes out and #ops is paged. So the corpus is built
// around the two ways that fails.
//
//   · Every fixture must produce a line the REAL judge accepts
//     (apps/web/lib/channel/voice/judge.ts, loaded live): inside the length cap, exactly
//     one question and it last, the kid / day / break label carried word for word, no
//     time / weekday / price / URL / phone the facts did not hand over, no compliance or
//     keyword-reply wording, tu and real accents in French 1:1, and no claim that Hale
//     booked anything.
//
//   · Every fixture must also be the RIGHT line for the moment — the per-kind direction
//     in the skill, scored by the judge model with `watchFor` as the fixture's notes.
//
// `request` is the exact ProactiveLineRequest the nudge sweep builds; `proactiveLineInput`
// (loaded live from apps/web/lib/channel/nudge/proactive-line.ts) turns it into what the
// model sees, so a change to the facts a kind hands over re-keys the cache here.

export const PROACTIVE_VOICE_FIXTURES = [
  {
    id: 'empty-saturday-en',
    language: 'en',
    address: 'tu',
    request: { kind: 'empty_saturday', kid: 'Maya' },
    watchFor:
      'Names Saturday and Maya. One question: whether they want one nearby find that is actually running. Must not name an activity, a place, a venue, a time, or the weather. Must not sound like a judgement about an empty day.',
  },
  {
    id: 'empty-saturday-fr',
    language: 'fr',
    address: 'tu',
    request: { kind: 'empty_saturday', kid: 'Léo' },
    watchFor:
      'French, tu, real accents. Names samedi and Léo. One question offering one nearby idea that is really running. No activity, place, time, or weather. Never vous.',
  },
  {
    id: 'empty-saturday-group-fr',
    language: 'fr',
    address: 'vous',
    request: { kind: 'empty_saturday', kid: 'Maya' },
    watchFor:
      'This copy lands in the household group, so vous. Names samedi and Maya. One question. No activity or place.',
  },
  {
    id: 'after-school-named-en',
    language: 'en',
    address: 'tu',
    request: {
      kind: 'weekday_care',
      ask: { prompt: 'after_school_named', childId: 'c1', name: 'Maya' },
    },
    watchFor:
      'Offers to find ONE good after-school option for Maya. One question. Must not name a program, a place, a day, a time, or a price. Must not mention a PA day or a break. Must not ask what their weekday care is.',
  },
  {
    id: 'after-school-named-fr',
    language: 'fr',
    address: 'tu',
    request: {
      kind: 'weekday_care',
      ask: { prompt: 'after_school_named', childId: 'c1', name: 'Noé' },
    },
    watchFor:
      'French, tu, real accents (après, école, idée). Offers one after-school option for Noé. One question. No program, place, day, or time.',
  },
  {
    id: 'after-school-household-en',
    language: 'en',
    address: 'tu',
    request: { kind: 'weekday_care', ask: { prompt: 'after_school_household' } },
    watchFor:
      'Names NO child. Offers to find one good after-school option nearby or for the kids. One question. No program, place, day, time, or price.',
  },
  {
    id: 'after-school-household-fr',
    language: 'fr',
    address: 'tu',
    request: { kind: 'weekday_care', ask: { prompt: 'after_school_household' } },
    watchFor:
      'French, tu, real accents. Names no child. One question offering one after-school option nearby. Never vous.',
  },
  {
    id: 'pa-day-en',
    language: 'en',
    address: 'tu',
    request: {
      kind: 'weekday_care',
      ask: { prompt: 'verified_break', eventKey: 'pa-day-2026-10-09', label: 'PA day' },
    },
    watchFor:
      'Says a PA day is coming up, using "PA day" word for word. Offers to find something nearby for it. One question. Must NOT give a date, a weekday, or a time. Must not name a program or a place.',
  },
  {
    id: 'march-break-en',
    language: 'en',
    address: 'tu',
    request: {
      kind: 'weekday_care',
      ask: { prompt: 'verified_break', eventKey: 'march-break-2027-03-15', label: 'March break' },
    },
    watchFor:
      'Says March break is coming up, using "March break" word for word. Offers to find something nearby. One question. No date, weekday, time, program, or place.',
  },
  {
    id: 'pa-day-fr',
    language: 'fr',
    address: 'tu',
    request: {
      kind: 'weekday_care',
      ask: {
        prompt: 'verified_break',
        eventKey: 'journee-pedagogique-2026-10-09',
        label: 'journée pédagogique',
      },
    },
    watchFor:
      'French, tu, real accents. Carries "journée pédagogique" word for word, says it is coming up, offers to find something nearby. One question. No date or time.',
  },
  {
    id: 'weekend-fallback-en',
    language: 'en',
    address: 'tu',
    request: { kind: 'weekday_care', ask: { prompt: 'weekend_fallback' } },
    watchFor:
      'The options Hale just sent were weekend ones; says so plainly and offers to find something for weekdays too. One question. Names no child, no program, no place, no day. Must not ask about daycare or what their weekday care is.',
  },
  {
    id: 'weekend-fallback-fr',
    language: 'fr',
    address: 'tu',
    request: { kind: 'weekday_care', ask: { prompt: 'weekend_fallback' } },
    watchFor:
      'French, tu, real accents (fin de semaine or week-end, semaine, idée). Says the options were for the weekend and offers weekday ones too. One question. Names nobody. Never vous.',
  },
  {
    id: 'weekend-fallback-group-en',
    language: 'en',
    address: 'vous',
    request: { kind: 'weekday_care', ask: { prompt: 'weekend_fallback' } },
    watchFor:
      'Lands in the household group, both parents reading. Says the options were weekend ones and offers weekday ones too. One question. Names nobody.',
  },
  {
    id: 'travel-brief-named-en',
    language: 'en',
    address: 'tu',
    request: {
      kind: 'travel_brief',
      city: 'New York',
      days: 'the 12th to the 15th',
      kids: ['Mia', 'Leo'],
    },
    watchFor:
      'The OPENING of a travel text; code appends one or two real finds right after it. Carries "New York", "the 12th to the 15th", Mia and Leo as given, says a couple of things are on there for them, and leads into a list (ends with a colon). No question. Must not name a place, an activity, a price or a time of its own. Under 110 characters.',
  },
  {
    id: 'travel-brief-group-nobody-en',
    language: 'en',
    address: 'vous',
    request: { kind: 'travel_brief', city: 'Montreal', days: 'the 3rd', kids: [] },
    watchFor:
      'Lands in the household group; both parents read it and Hale does not know which of them is going, so it says the trip rather than "you\'re in". Carries "Montreal" and "the 3rd" as given, says "the kids" and names nobody, leads into the list with a colon. No question. No place, activity, price or time of its own.',
  },
];
