// Group onboarding voice — the corpus.
//
// The lines Hale says when it joins a family's group and asks who is who
// (packages/agent/skills/group-onboarding-voice.md). Every fixture must produce a line the
// REAL judge accepts (apps/web/lib/channel/voice/judge.ts, loaded live) under the per-kind
// red lines the REAL request builder hands over
// (apps/web/lib/channel/linq/group-onboarding-line-input.ts, loaded live): Hale named in
// the asks and the no-family line, every role word carried, no role asserted for anyone,
// no calendar or Gmail word, no booking claim, vous and real accents in French. And it must
// be the right line for the moment, scored by the judge model against `watchFor`.
//
// Names are fixtures, not people: no real family is described here.

export const GROUP_ONBOARDING_VOICE_FIXTURES = [
  {
    id: 'roster-ask-3-en',
    language: 'en',
    request: { kind: 'roster_ask', knownParentName: 'Riley', rosterSize: 3 },
    watchFor:
      "Hale says who it is (a kids' year planner) and that it is here for Riley's family, then ONE question asking everyone else to say, each for themselves, whether they are mom, dad, grandparent, nanny, babysitter, or not family. Must not guess anyone's role, must not ask Riley to say who the others are, must not mention calendars, email, links, or plans.",
  },
  {
    id: 'roster-ask-3-fr',
    language: 'fr',
    request: { kind: 'roster_ask', knownParentName: 'Riley', rosterSize: 3 },
    watchFor:
      "French, vous, real accents. Hale se présente et dit être là pour la famille de Riley, puis UNE question : que chacun dise pour soi s'il est maman, papa, grand-parent, nounou, gardienne ou pas de la famille. Aucune supposition de rôle, aucun calendrier ni courriel.",
  },
  {
    id: 'roster-ask-5-en',
    language: 'en',
    request: { kind: 'roster_ask', knownParentName: 'Morgan', rosterSize: 5 },
    watchFor:
      'A bigger chat. Same job: Hale identifies itself, names Morgan, asks the rest to answer for themselves with every role word including not family. Must not number or list the people, must not say how many there are as if that were the point.',
  },
  {
    id: 'roster-ask-5-fr',
    language: 'fr',
    request: { kind: 'roster_ask', knownParentName: 'Morgan', rosterSize: 5 },
    watchFor:
      'French, vous. Hale se présente, nomme Morgan, et demande aux autres de répondre chacun pour soi avec tous les rôles, y compris pas de la famille. Pas de tu, pas de on pour Hale.',
  },
  {
    id: 'roster-ask-no-name-en',
    language: 'en',
    request: { kind: 'roster_ask', knownParentName: null, rosterSize: 3 },
    watchFor:
      "The parent's name is unknown. Hale identifies itself and says it is here for this family without inventing a name, then asks the rest who they are with every role word.",
  },
  {
    id: 'member-ask-en',
    language: 'en',
    request: { kind: 'member_ask', knownParentName: 'Riley' },
    watchFor:
      "Someone was just added. A short greeting, that this is Riley's family thread, and ONE question asking them who they are: mom, dad, grandparent, nanny, babysitter, or not family. Must not mention anyone else in the group or guess who they are.",
  },
  {
    id: 'member-ask-fr',
    language: 'fr',
    request: { kind: 'member_ask', knownParentName: 'Riley' },
    watchFor:
      'French, vous, real accents. Un bref accueil, le fil de la famille de Riley, et UNE question sur qui ils sont avec tous les rôles. Aucune supposition.',
  },
  {
    id: 'role-reask-en',
    language: 'en',
    request: { kind: 'role_reask' },
    parentWords: "it's me lol",
    watchFor:
      'They answered "it\'s me lol". Ask again lightly, without making them feel wrong and without guessing, with every role word. ONE question. Must not repeat their words back as a guess.',
  },
  {
    id: 'role-reask-fr',
    language: 'fr',
    request: { kind: 'role_reask' },
    parentWords: "c'est moi lol",
    watchFor:
      "French, vous. Redemander gentiment, sans supposer, avec tous les rôles. UNE question. Ne pas reprendre « c'est moi » comme une supposition.",
  },
  {
    id: 'role-confirmed-mom-en',
    language: 'en',
    request: { kind: 'role_confirmed', name: null, role: 'mom' },
    parentWords: "I'm the mom",
    watchFor:
      'A short thanks that says back, in their own word, that they are mom. No question, no next steps, no plans, no calendar.',
  },
  {
    id: 'role-confirmed-mom-fr',
    language: 'fr',
    request: { kind: 'role_confirmed', name: null, role: 'mom' },
    parentWords: "c'est la maman",
    watchFor: 'French, vous. Un bref merci qui reprend « maman ». Aucune question, aucune suite.',
  },
  {
    id: 'role-confirmed-grandparent-en',
    language: 'en',
    request: { kind: 'role_confirmed', name: 'Pat', role: 'grandparent' },
    parentWords: 'grandma here!',
    watchFor:
      'Thanks Pat by name and says back that they are a grandparent. No question. Must not promise anything about the kids or plans.',
  },
  {
    id: 'role-confirmed-grandparent-fr',
    language: 'fr',
    request: { kind: 'role_confirmed', name: 'Pat', role: 'grandparent' },
    parentWords: "c'est mamie",
    watchFor: 'French, vous. Remercie Pat par son nom, reprend grand-parent. Aucune question.',
  },
  {
    id: 'role-confirmed-nanny-en',
    language: 'en',
    request: { kind: 'role_confirmed', name: null, role: 'nanny' },
    parentWords: 'nanny :)',
    watchFor: 'A short thanks that says back they are the nanny. No question, no plans.',
  },
  {
    id: 'role-confirmed-nanny-fr',
    language: 'fr',
    request: { kind: 'role_confirmed', name: null, role: 'nanny' },
    parentWords: 'la nounou',
    watchFor: 'French, vous. Un bref merci qui reprend nounou. Aucune question.',
  },
  {
    id: 'no-family-yet-en',
    language: 'en',
    request: { kind: 'no_family_yet' },
    watchFor:
      "Hale was added to a group where it knows nobody. Says it is Hale, a kids' year planner, that one of the parents should text Hale directly to set up their kids' year, and that until then Hale stays quiet here. No question. Must not write a number or a link.",
  },
  {
    id: 'no-family-yet-fr',
    language: 'fr',
    request: { kind: 'no_family_yet' },
    watchFor:
      "French, vous. Hale se présente, dit qu'un des parents doit lui écrire directement pour préparer l'année des enfants, et que d'ici là il reste discret ici. Aucune question, aucun numéro.",
  },
];
