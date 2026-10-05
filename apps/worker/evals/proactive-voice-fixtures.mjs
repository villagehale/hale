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
  // ── travel_brief ─────────────────────────────────────────────────────────────
  // The WHOLE travel text is the model's now (VIL-413 / VIL-417): until this change the
  // opening was spoken and the two picks plus the closing "their own pages" sentence were
  // fixed templates in lib/travel/copy.ts. The picks arrive as facts, each exactly as the
  // venue published it; the brief must carry every one of their words and say in its own
  // words where they came from. The eval also runs the travel lint
  // (lib/travel/brief-lint.ts) that the sweep runs before sending.
  {
    id: 'travel-brief-named-en',
    language: 'en',
    address: 'tu',
    request: {
      kind: 'travel_brief',
      city: 'New York',
      days: 'the 12th to the 15th',
      kids: ['Mia', 'Leo'],
      picks: [
        {
          name: "Brooklyn Children's Museum",
          when: 'Tue-Sun 10am-5pm',
          price: '$15 per person',
        },
        { name: 'Pier 25 Mini Golf', when: 'daily from 11am', price: '$8 a round' },
      ],
    },
    watchFor:
      'A whole travel text, no list to follow. Carries "New York", "the 12th to the 15th", Mia and Leo as given. Names both picks and carries each one\'s when and price EXACTLY as written ("Tue-Sun 10am-5pm", "$15 per person", "daily from 11am", "$8 a round"), no digit changed, none added. Then says in its own words that those details are off the venues\' own pages and nobody has been to check. No question. No recommendation, distance, or place of its own. Plain ASCII, under 500 characters.',
  },
  {
    id: 'travel-brief-group-nobody-en',
    language: 'en',
    address: 'vous',
    request: {
      kind: 'travel_brief',
      city: 'Montreal',
      days: 'the 3rd',
      kids: [],
      picks: [{ name: 'Biodome', when: 'Tue-Sun 9am-5pm', price: '$24 adults, $12 kids' }],
    },
    watchFor:
      'Lands in the household group; both parents read it and Hale does not know which of them is going, so it says the trip rather than "you\'re in". Carries "Montreal" and "the 3rd" as given, says "the kids" and names nobody. One pick: "Biodome" with "Tue-Sun 9am-5pm" and "$24 adults, $12 kids" exactly as written. Says in its own words that the details are off the venue\'s own page and nobody has been. No question. No second find invented.',
  },
  {
    id: 'travel-brief-null-price-en',
    language: 'en',
    address: 'tu',
    request: {
      kind: 'travel_brief',
      city: 'Ottawa',
      days: 'the 20th to the 21st',
      kids: ['Noah'],
      picks: [
        { name: 'Canada Science and Technology Museum', when: null, price: '$18 adults' },
        { name: 'Rideau Canal Skateway', when: 'open dawn to dusk', price: null },
      ],
    },
    watchFor:
      'Carries "Ottawa", "the 20th to the 21st" and Noah. Names both picks. The museum has no when and the Skateway has no price: those are simply not said, never filled in ("free", "all day", a guessed hour or fee are all wrong). Carries "$18 adults" and "open dawn to dusk" exactly. Says in its own words the details are off the venues\' own pages and nobody has checked. No question.',
  },
];
