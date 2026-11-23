// The group join intro - the corpus (VIL-727, `join_intro`).
//
// Each case is a SCENARIO, not a hand-written fact list: the runner builds the claims with
// the product's own `groupJoinIntroClaims` and the request with `groupOnboardingLineInput`,
// so a case means what production would hand the model for that group. `otherPeople` is
// everyone in the chat besides Hale; a group of three (two parents and Hale) is too small
// for anyone to remove a member, so that claim is left out there. There is no fixed copy
// and no word gate: the judge reads the claims, the register and the language.

export const GROUP_JOIN_INTRO_FIXTURES = [
  {
    id: 'en-household-asks',
    language: 'en',
    audience: 'household',
    knownParentName: 'Maya',
    adderName: null,
    ask: 'who_in_family',
    otherPeople: 4,
    turnReaderLive: true,
    mailNoticeLive: false,
    watchFor:
      "Who Hale is: an AI agent you text for the kids' year, not only a planner. The four household claims, in Hale's own words: reads this chat, email is never shown here, speaks when called, anyone can remove Hale. Says nothing about private texts or a 1:1. Says Hale is here for Maya's family. Ends with one question asking each person who they are in this family; no list of roles. No STOP or HELP.",
  },
  {
    id: 'en-household-known-trio',
    language: 'en',
    audience: 'household',
    knownParentName: 'Sam',
    adderName: null,
    ask: 'none',
    otherPeople: 2,
    turnReaderLive: true,
    mailNoticeLive: false,
    watchFor:
      "Who Hale is: an AI agent you text for the kids' year, not only a planner. A group of three where everyone is known: no question at all. Nothing about removing Hale, leaving, or opting out, because nobody in a group this small can remove a member. Nothing about private texts or a 1:1. No STOP or HELP.",
  },
  {
    id: 'fr-household-asks',
    language: 'fr',
    audience: 'household',
    knownParentName: 'Camille',
    adderName: null,
    ask: 'who_in_family',
    otherPeople: 3,
    turnReaderLive: true,
    mailNoticeLive: false,
    watchFor:
      "Who Hale is: an AI agent you text for the kids' year, not only a planner. French, vous throughout (never tu), real accents. The four household claims and nothing about private texts or a 1:1. Says Hale is here for the family of Camille. One question: who each person is in this family. No STOP, HELP, ARRET or AIDE.",
  },
  {
    id: 'en-household-reader-dark',
    language: 'en',
    audience: 'household',
    knownParentName: 'Priya',
    adderName: null,
    ask: 'who_in_family',
    otherPeople: 5,
    turnReaderLive: false,
    mailNoticeLive: true,
    watchFor:
      "Who Hale is: an AI agent you text for the kids' year, not only a planner. Only two claims: Hale reads this chat, and anyone can remove it. Says nothing about when Hale speaks or stays quiet, nothing about email, nothing about private texts or a 1:1. One question about who each person is.",
  },
  {
    id: 'en-household-no-name',
    language: 'en',
    audience: 'household',
    knownParentName: null,
    adderName: null,
    ask: 'who_in_family',
    otherPeople: 3,
    turnReaderLive: true,
    mailNoticeLive: false,
    watchFor:
      "Who Hale is: an AI agent you text for the kids' year, not only a planner. No parent name is known, so none may be invented: \"this family\" or similar is right. The four household claims, nothing about private texts or a 1:1, and one question.",
  },
  {
    id: 'en-shared-adder',
    language: 'en',
    audience: 'shared',
    knownParentName: null,
    adderName: 'Jordan',
    ask: 'who_and_kid',
    otherPeople: 6,
    turnReaderLive: true,
    mailNoticeLive: false,
    watchFor:
      "Who Hale is: an AI agent you text for the kids' year, not only a planner. English throughout. The address field is vous on every group line and is not a word in the message: do not write vous, and do not treat it as present. A group several families share. Says Jordan added Hale, and names no household as the one Hale works for. Reads this chat, email is never shown, speaks when called, anyone can remove Hale. Do not require a private-text claim, and say nothing about private texts or a 1:1. One question: who each person is and which kid they are with; no role list and no child named.",
  },
  {
    id: 'es-shared-no-adder',
    language: 'es',
    audience: 'shared',
    knownParentName: null,
    adderName: null,
    ask: 'who_and_kid',
    otherPeople: 5,
    turnReaderLive: true,
    mailNoticeLive: false,
    watchFor:
      "Who Hale is: an AI agent you text for the kids' year, not only a planner. Spanish, with every accent a native speaker writes (ñ, á, é, í, ó, ú), never the unaccented letter in their place. Plural you to the whole group (ustedes), never tú. Names nobody as the adder and no household. Reads this chat, email is never shown, speaks when called, anyone can remove Hale. Do not require a private-text claim, and say nothing about private texts or a 1:1. One question about who they are and which kid they are with.",
  },
  {
    id: 'fr-shared-small',
    language: 'fr',
    audience: 'shared',
    knownParentName: null,
    adderName: 'Léa',
    ask: 'who_and_kid',
    otherPeople: 2,
    turnReaderLive: true,
    mailNoticeLive: false,
    watchFor:
      "Who Hale is: an AI agent you text for the kids' year, not only a planner. French, vous throughout. Says Léa added Hale. Reads this chat, email is never shown, and speaks when called. Nothing about private texts or a 1:1, and nothing about removing Hale or leaving, because a group of three cannot remove a member. One question about who they are and which kid they are with.",
  },
];
