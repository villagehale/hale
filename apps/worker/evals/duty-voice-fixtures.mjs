// The co-parent duty voice — the corpus.
//
// Every word Hale says in a household group about who has a kid's thing — the Sunday
// overview, the night-before reminder, the nudge that nobody has claimed one, and the
// answers to a parent who just asked or just claimed — is written by the model from real
// facts (packages/agent/skills/duty-voice.md). Until VIL-413 / VIL-417 this lane was
// coparent/duty/copy.ts: eleven locked templates in two languages (`DUTY_*_COPY`), a
// list formatter and an owner echo. There is no fixed sentence underneath any of them
// now. What the model writes is what both parents read, or the bubble is withheld and
// #ops is paged. So the corpus is built around the two ways that fails.
//
//   · Every fixture must produce a line the REAL judge accepts
//     (apps/web/lib/channel/voice/judge.ts, loaded live): inside the length cap, exactly
//     one question and it last on the asks and none on the others, every name / event /
//     day / time carried word for word, no time / weekday / price / URL / phone the facts
//     did not hand over, no compliance or keyword-reply wording, no scorekeeping between
//     the parents, no claim that Hale drives or booked anything, vous to the group and tu
//     to one named parent with real accents in French.
//
//   · Every fixture must also be the RIGHT line for the moment — the per-kind direction
//     in the skill, scored by the judge model with `watchFor` as the fixture's notes.
//
// `request` is the exact DutyLineRequest the sweep and the reply handler build;
// `dutyLineInput` (loaded live from apps/web/lib/channel/coparent/duty/line-input.ts)
// turns it into what the model sees, so a change to the facts a kind hands over re-keys
// the cache. Days and times arrive as the lane formats them: weekday words, "3:00pm" in
// English, "15:00" in French.

export const DUTY_VOICE_FIXTURES = [
  // ── week_overview ────────────────────────────────────────────────────────────
  {
    id: 'week-overview-en',
    language: 'en',
    request: {
      kind: 'week_overview',
      entries: [
        { day: 'Monday', event: 'swim', owner: 'Sam' },
        { day: 'Wednesday', event: 'piano', owner: null },
        { day: 'Saturday', event: 'soccer', owner: 'Alex' },
      ],
    },
    watchFor:
      'Sunday, to both parents (vous register in spirit: no "you" singular aimed at one of them). Every entry present with its day, event and owner as written: Monday swim Sam, Wednesday piano with nobody yet (said in its own words, no name guessed or suggested), Saturday soccer Alex. No question. No time, place or extra event invented. Nothing about who does more. Up to four short sentences, under 480 characters.',
  },
  {
    id: 'week-overview-fr',
    language: 'fr',
    request: {
      kind: 'week_overview',
      entries: [
        { day: 'mardi', event: 'natation', owner: 'Camille' },
        { day: 'jeudi', event: 'cours de dessin', owner: null },
      ],
    },
    watchFor:
      'French, vous to both parents, real accents. mardi natation Camille; jeudi cours de dessin with nobody yet, said in its own words. No question. No invented time or place. No "encore une fois" or "comme d\'habitude".',
  },
  {
    id: 'week-overview-all-owned-en',
    language: 'en',
    request: {
      kind: 'week_overview',
      entries: [
        { day: 'Tuesday', event: 'dentist', owner: 'Jordan' },
        { day: 'Friday', event: 'gymnastics', owner: 'Jordan' },
      ],
    },
    watchFor:
      "Both are Jordan's. Says so plainly, each with its day and event. Must NOT remark on Jordan having both, on the other parent having none, on fairness or turns. No question.",
  },

  // ── reask ────────────────────────────────────────────────────────────────────
  {
    id: 'reask-en',
    language: 'en',
    request: { kind: 'reask', kid: 'Maya', event: 'swim', day: 'Thursday', time: '4:00pm' },
    watchFor:
      'Two days on, still nobody on Maya\'s swim, Thursday at 4:00pm. Says so without blame and asks who is taking it. Exactly one question, the last sentence. Carries Maya, swim, Thursday and 4:00pm exactly. No "again", no sigh, no keyword to reply with.',
  },
  {
    id: 'reask-fr',
    language: 'fr',
    request: { kind: 'reask', kid: 'Léo', event: 'hockey', day: 'samedi', time: '08:30' },
    watchFor:
      'French, vous, real accents. Personne n\'a encore the hockey de Léo samedi à 08:30; asks who takes it. One question, last. Carries Léo, hockey, samedi, 08:30 exactly. No blame, no "encore".',
  },

  // ── night_before ─────────────────────────────────────────────────────────────
  {
    id: 'night-before-en',
    language: 'en',
    request: { kind: 'night_before', owner: 'Sam', kid: 'Maya', event: 'swim', time: '3:00pm' },
    watchFor:
      'Tomorrow: Sam has Maya\'s swim at 3:00pm. A reminder to both, and makes it known in passing that if that changes they can just say so here. No question. Must not say "Text me if that changes", "I\'ll note it" or "Noted". Must not say Hale will drive or pick anyone up. Carries Sam, Maya, swim, 3:00pm exactly.',
  },
  {
    id: 'night-before-fr',
    language: 'fr',
    request: {
      kind: 'night_before',
      owner: 'Camille',
      kid: 'Noé',
      event: 'natation',
      time: '17:30',
    },
    watchFor:
      'French, vous, real accents (demain, à). Camille has Noé\'s natation at 17:30 tomorrow; if that changes they can just say so here. No question. No "je le note". Carries Camille, Noé, natation, 17:30 exactly.',
  },

  // ── owner ────────────────────────────────────────────────────────────────────
  {
    id: 'owner-answer-en',
    language: 'en',
    request: {
      kind: 'owner',
      owner: 'Alex',
      kid: 'Leo',
      event: 'soccer',
      day: 'Saturday',
      time: '10:00am',
      recorded: false,
    },
    watchFor:
      "A parent asked who has Leo's soccer Saturday at 10:00am; Alex does. One plain line answering that. No question. Carries Alex, Leo, soccer, Saturday, 10:00am exactly. Nothing about turns.",
  },
  {
    id: 'owner-recorded-en',
    language: 'en',
    request: {
      kind: 'owner',
      owner: 'Sam',
      kid: 'Maya',
      event: 'swim',
      day: 'Thursday',
      time: '4:00pm',
      recorded: true,
    },
    watchFor:
      'Hale just wrote down, from what Sam said, that Sam has Maya\'s swim Thursday at 4:00pm. Confirms it back and makes it easy to correct ("if I\'ve got that wrong, say so here" in its own words). No question. No "Noted" or "I\'ll keep track". Carries all five facts exactly.',
  },
  {
    id: 'owner-recorded-fr',
    language: 'fr',
    request: {
      kind: 'owner',
      owner: 'Camille',
      kid: 'Léo',
      event: 'hockey',
      day: 'samedi',
      time: '08:30',
      recorded: true,
    },
    watchFor:
      'French, vous, real accents. Confirms back that Camille has Léo\'s hockey samedi à 08:30 and that it is easy to correct here if wrong. No question. No "je le note". Carries all five facts exactly.',
  },

  // ── nobody_yet ───────────────────────────────────────────────────────────────
  {
    id: 'nobody-yet-en',
    language: 'en',
    request: { kind: 'nobody_yet', kid: 'Leo', event: 'piano', day: 'Wednesday', time: '5:30pm' },
    watchFor:
      "A parent asked who has Leo's piano Wednesday at 5:30pm, and nobody has said. Says that and asks who is taking it. One question, last. Carries Leo, piano, Wednesday, 5:30pm exactly. No suggestion of who should.",
  },
  {
    id: 'nobody-yet-fr',
    language: 'fr',
    request: { kind: 'nobody_yet', kid: 'Noé', event: 'dessin', day: 'jeudi', time: '16:00' },
    watchFor:
      "French, vous, real accents. Personne n'a encore the dessin de Noé jeudi à 16:00; asks who takes it. One question, last. Carries Noé, dessin, jeudi, 16:00 exactly.",
  },

  // ── which_kid (tu, to one parent) ────────────────────────────────────────────
  {
    id: 'which-kid-en',
    language: 'en',
    request: { kind: 'which_kid', name: 'Sam', kids: ['Maya', 'Leo'] },
    watchFor:
      'Sam just said they have something and Hale cannot tell which kid. Speaks to Sam by name, briefly acknowledges, and asks which kid - naming Maya and Leo and making clear it can be both. One question, last. Nothing about what the thing is (Hale was not told). No keyword to reply with.',
  },
  {
    id: 'which-kid-fr',
    language: 'fr',
    request: { kind: 'which_kid', name: 'Camille', kids: ['Léo', 'Noé'] },
    watchFor:
      'French, TU to Camille by name (never vous), real accents. Asks which kid, naming Léo and Noé, and that it can be both. One question, last.',
  },

  // ── both_claimed ─────────────────────────────────────────────────────────────
  {
    id: 'both-claimed-en',
    language: 'en',
    request: {
      kind: 'both_claimed',
      event: 'swim',
      day: 'Thursday',
      parentA: 'Sam',
      parentB: 'Alex',
    },
    watchFor:
      'Both Sam and Alex said they have swim Thursday. Says so lightly - it happens - and asks which of them is taking it, naming both. One question, last. Picks no winner, keeps no score. Carries swim, Thursday, Sam, Alex exactly.',
  },
  {
    id: 'both-claimed-fr',
    language: 'fr',
    request: {
      kind: 'both_claimed',
      event: 'natation',
      day: 'mardi',
      parentA: 'Camille',
      parentB: 'Jordan',
    },
    watchFor:
      'French, vous, real accents. Camille and Jordan both said they have natation mardi; asks which of them takes it, naming both. One question, last. No winner picked.',
  },

  // ── silent_parent (tu, to one parent) ────────────────────────────────────────
  {
    id: 'silent-parent-en',
    language: 'en',
    request: { kind: 'silent_parent', name: 'Alex', event: 'piano', day: 'Wednesday' },
    watchFor:
      'Hands piano Wednesday to Alex, by name: it is Alex\'s to say. No question, no pressure, and NO mention that the other parent already answered or that anyone is waiting. Must not say "your turn". Carries Alex, piano, Wednesday exactly.',
  },
  {
    id: 'silent-parent-fr',
    language: 'fr',
    request: { kind: 'silent_parent', name: 'Jordan', event: 'dessin', day: 'jeudi' },
    watchFor:
      'French, TU to Jordan by name (never vous), real accents. Hands dessin jeudi to Jordan to say. No question, no pressure, no "à ton tour", no mention of the other parent.',
  },
];
