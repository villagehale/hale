import { assembleFriendBody, type FriendVoiceInput } from './friend-voice';

/**
 * VIL-413. Three onboarding conversations the friend-voice judge checks.
 * The replies are the words a passing model is allowed to send: grounded in
 * the find, one question, none of the stock lines. They are not a live model
 * call. The skill eval is the live check; this is the gate that runs in CI.
 */

const CALENDAR_LINK = 'https://app.villagehale.com/connect?t=sample&to=gcal';
const GMAIL_LINK = 'https://app.villagehale.com/connect?t=sample&to=gmail';
const SWIM = 'Swim (ages 3-5) - Saturdays 10am - $12';
const STORY = 'Storytime (all ages) - Tuesday 10:30am - free';
const NATATION = 'Natation (3-5 ans) - samedi 10h - $12';

export interface FriendFixtureTurn {
  title: string;
  input: FriendVoiceInput;
  link?: string;
  /** Prose the model writes. Code appends the list and the link. */
  prose: string;
}

export interface FriendFixtureConversation {
  id: string;
  title: string;
  turns: readonly FriendFixtureTurn[];
}

function input(over: Partial<FriendVoiceInput> & Pick<FriendVoiceInput, 'step' | 'parentWords'>): FriendVoiceInput {
  return {
    language: 'en',
    address: 'tu',
    introduce: false,
    recentTurns: [],
    placeLabel: null,
    agesLabel: null,
    ageMonths: [],
    findLines: [],
    listKind: 'none',
    activity: null,
    day: null,
    parentName: null,
    ...over,
  };
}

export const FRIEND_CONVERSATIONS: readonly FriendFixtureConversation[] = [
  {
    id: 'en-first-touch-to-calendar',
    title: 'English first text through the calendar link',
    turns: [
      {
        title: 'postal code',
        prose: "Hey, it's Hale. What's your postal code?",
        input: input({
          step: 'place',
          introduce: true,
          parentWords: "Hey Hale, what's going on?",
        }),
      },
      {
        title: 'ages, no empty week list',
        prose: 'M5V, got it. How old are the kids?',
        input: input({
          step: 'ages',
          parentWords: 'M5V 2T6',
          placeLabel: 'M5V',
          recentTurns: [
            { role: 'parent', body: "Hey Hale, what's going on?" },
            { role: 'hale', body: "Hey, it's Hale. What's your postal code?" },
          ],
        }),
      },
      {
        title: 'year list, one question, no stock pick line',
        prose: 'Maya is 4 and Leo is 1, near M5V. Which of these feels right?',
        input: input({
          step: 'find_pick',
          parentWords: 'Maya is 4 and Leo is 1',
          placeLabel: 'M5V',
          agesLabel: 'a 4-year-old and a 1-year-old',
          ageMonths: [48, 12],
          findLines: [SWIM, STORY],
          listKind: 'year',
        }),
      },
      {
        title: 'name, not a logistics note',
        prose: 'Saturday swim it is. What should I call you?',
        input: input({
          step: 'names',
          parentWords: '1',
          activity: 'Swim',
          day: 'Saturdays 10am',
          findLines: [SWIM],
        }),
      },
      {
        title: 'calendar link attached',
        prose: 'Dana, want me to check that swim against your calendar? This link is just for you.',
        link: CALENDAR_LINK,
        input: input({
          step: 'calendar',
          parentWords: 'Dana',
          parentName: 'Dana',
          activity: 'Swim',
          day: 'Saturdays 10am',
        }),
      },
    ],
  },
  {
    id: 'fr-tu-accents',
    title: 'French, tu, with a receipt and accents',
    turns: [
      {
        title: 'code postal',
        prose:
          "Salut, c'est Hale. Je trouve ce qui se passe pour les enfants près de chez toi. Quel est ton code postal?",
        input: input({
          step: 'place',
          language: 'fr',
          introduce: true,
          parentWords: "Salut Hale, qu'est-ce qui se passe?",
        }),
      },
      {
        title: 'âges',
        prose: "C'est noté, près de H2X. Quel âge ont les enfants?",
        input: input({
          step: 'ages',
          language: 'fr',
          parentWords: 'H2X 1Y4',
          placeLabel: 'H2X',
        }),
      },
      {
        title: 'liste de l’année',
        prose: 'Léa a 4 ans, près de H2X. Lequel te tente?',
        input: input({
          step: 'find_pick',
          language: 'fr',
          parentWords: 'Léa a 4 ans',
          placeLabel: 'H2X',
          agesLabel: '4 ans',
          ageMonths: [48],
          findLines: [NATATION],
          listKind: 'year',
        }),
      },
      {
        title: 'prénom',
        prose: "Comment je t'appelle?",
        input: input({
          step: 'names',
          language: 'fr',
          parentWords: '1',
          activity: 'Natation',
        }),
      },
      {
        title: 'calendrier avec le lien',
        prose: 'Tu veux que je compare la natation à ton calendrier? Ce lien est juste pour toi.',
        link: CALENDAR_LINK,
        input: input({
          step: 'calendar',
          language: 'fr',
          parentWords: 'Camille',
          parentName: 'Camille',
          activity: 'Natation',
        }),
      },
    ],
  },
  {
    id: 'en-everything-first',
    title: 'Parent gives kids, ages, and a postal code in the first text',
    turns: [
      {
        title: 'straight to the year list',
        prose: 'Maya is 4 and Leo is 1, near M6J. Which of these should I look at?',
        input: input({
          step: 'find_pick',
          introduce: true,
          parentWords: "Hey, Maya is 4, Leo is 1, we're in M6J 1A1",
          placeLabel: 'M6J',
          agesLabel: 'a 4-year-old and a 1-year-old',
          ageMonths: [48, 12],
          findLines: [SWIM],
          listKind: 'year',
        }),
      },
      {
        title: 'gmail link on its own turn',
        prose: 'Want me to watch school and camp email for the dates? This link is just for you.',
        link: GMAIL_LINK,
        input: input({
          step: 'email',
          parentWords: 'Dana',
          parentName: 'Dana',
          placeLabel: 'M6J',
        }),
      },
    ],
  },
];

export function fixtureBody(turn: FriendFixtureTurn): string {
  return assembleFriendBody(turn.prose, turn.input, turn.link ?? null);
}
