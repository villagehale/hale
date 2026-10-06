import { type FriendVoiceInput, assembleFindShowBubbles, assembleFriendBody } from './friend-voice';

/**
 * VIL-413 / VIL-417. Three onboarding conversations the friend-voice judge
 * checks, on the current order: postal, kids' names, ages, the activity map
 * (no question), the parent's name as its own later message, Gmail, calendar,
 * schedule, co-parent. The replies are the words a passing model is allowed to
 * send: grounded in the find, one question at most, none of the stock lines.
 * They are not a live model call. The skill eval is the live check; this is
 * the gate that runs in CI.
 */

const CALENDAR_LINK = 'https://app.villagehale.com/connect?t=sample&to=gcal';
const GMAIL_LINK = 'https://app.villagehale.com/connect?t=sample&to=gmail';
const SWIM = 'Swim (ages 3-5) - Saturdays 10am - $12';
const STORY = 'Storytime (all ages) - Tuesday 10:30am - free';
const EARLYON = 'EarlyON drop-in (0-6) - weekday mornings - free';
const NATATION = 'Natation (3-5 ans) - samedi 10h - $12';
const CONTE = "L'heure du conte (tous âges) - mardi 10h30 - gratuit";

export interface FriendFixtureTurn {
  title: string;
  input: FriendVoiceInput;
  link?: string;
  /** Prose the model writes. Code appends the list and the link. */
  prose: string;
  /** find_show only: one short lead per group, in group order. */
  groupLeads?: readonly string[];
}

export interface FriendFixtureConversation {
  id: string;
  title: string;
  turns: readonly FriendFixtureTurn[];
}

function input(
  over: Partial<FriendVoiceInput> & Pick<FriendVoiceInput, 'step' | 'parentWords'>,
): FriendVoiceInput {
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
    id: 'en-first-touch-to-coparent',
    title: 'English first text through the co-parent ask',
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
        title: 'kids names, one ask',
        prose: "M5V, got it. What are your kids' names?",
        input: input({
          step: 'kids_names',
          parentWords: 'M5V 2T6',
          placeLabel: 'M5V',
          recentTurns: [
            { role: 'parent', body: "Hey Hale, what's going on?" },
            { role: 'hale', body: "Hey, it's Hale. What's your postal code?" },
          ],
        }),
      },
      {
        title: 'ages, no empty week list',
        prose: 'Maya and Leo. How old are they?',
        input: input({
          step: 'ages',
          parentWords: 'Maya and Leo',
          placeLabel: 'M5V',
        }),
      },
      {
        title: 'the map, grouped for their ages, no question',
        prose: 'Here is what is on near M5V for a 4-year-old and a 1-year-old.',
        groupLeads: ['Weekends', 'Free drop-ins'],
        input: input({
          step: 'find_show',
          parentWords: 'Maya is 4 and Leo is 1',
          placeLabel: 'M5V',
          agesLabel: 'a 4-year-old and a 1-year-old',
          ageMonths: [48, 12],
          findLines: [SWIM, STORY, EARLYON],
          findGroups: [
            { category: 'weekend', lines: [SWIM] },
            { category: 'free_public', lines: [STORY, EARLYON] },
          ],
          listKind: 'year',
        }),
      },
      {
        title: 'the name, its own later message',
        prose: 'And what should I call you?',
        input: input({
          step: 'names',
          parentWords: 'Maya is 4 and Leo is 1',
          placeLabel: 'M5V',
          findLines: [SWIM, STORY, EARLYON],
        }),
      },
      {
        title: 'gmail, trust lines, link on its own',
        prose:
          'Dana, Google shares the whole inbox and I keep only kid-activity mail, never send anything for you, and you can disconnect any time. Google may show an unverified app screen; Advanced, then continue. Want me to watch for the registration dates?',
        link: GMAIL_LINK,
        input: input({
          step: 'email',
          parentWords: 'Dana',
          parentName: 'Dana',
          placeLabel: 'M5V',
          findLines: [SWIM, STORY, EARLYON],
        }),
      },
      {
        title: 'calendar link attached',
        prose:
          'Same deal for the calendar: I read it, I never write to it without a yes, and you can disconnect any time. Want me to check the swim against it?',
        link: CALENDAR_LINK,
        input: input({
          step: 'calendar',
          parentWords: 'done',
          parentName: 'Dana',
          activity: 'Swim',
          day: 'Saturdays 10am',
          findLines: [SWIM, STORY, EARLYON],
        }),
      },
      {
        title: 'schedule, one activity, a sensible default, a reminder not a registration',
        prose:
          'Want the swim on your calendar as a weekly reminder, Saturdays 10am from this week?',
        input: input({
          step: 'schedule',
          parentWords: 'connected',
          parentName: 'Dana',
          activity: 'Swim',
          day: 'Saturdays 10am',
          findLines: [SWIM, STORY, EARLYON],
          now: new Date('2026-10-05T14:00:00.000Z'),
        }),
      },
      {
        title: 'co-parent, asked once, softly',
        prose:
          'Last one. The other parent would see the same finds and reminders, nothing else. Want me to set up a group chat with them?',
        input: input({
          step: 'coparent',
          parentWords: 'yes weekly',
          parentName: 'Dana',
          scheduled: [{ title: 'Swim', when: 'Saturdays 10am', cadence: 'weekly' }],
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
        title: 'prénoms des enfants',
        prose: "C'est noté, près de H2X. Comment s'appellent tes enfants?",
        input: input({
          step: 'kids_names',
          language: 'fr',
          parentWords: 'H2X 1Y4',
          placeLabel: 'H2X',
        }),
      },
      {
        title: 'âges',
        prose: 'Léa, joli. Quel âge a-t-elle?',
        input: input({
          step: 'ages',
          language: 'fr',
          parentWords: 'Léa',
          placeLabel: 'H2X',
        }),
      },
      {
        title: 'la carte, sans question',
        prose: 'Voici ce qui se passe près de H2X pour une enfant de 4 ans.',
        groupLeads: ['La fin de semaine', 'Gratuit'],
        input: input({
          step: 'find_show',
          language: 'fr',
          parentWords: 'Léa a 4 ans',
          placeLabel: 'H2X',
          agesLabel: '4 ans',
          ageMonths: [48],
          findLines: [NATATION, CONTE],
          findGroups: [
            { category: 'weekend', lines: [NATATION] },
            { category: 'free_public', lines: [CONTE] },
          ],
          listKind: 'year',
        }),
      },
      {
        title: 'prénom',
        prose: "Et toi, comment je t'appelle?",
        input: input({
          step: 'names',
          language: 'fr',
          parentWords: 'Léa a 4 ans',
          findLines: [NATATION, CONTE],
        }),
      },
      {
        title: 'gmail avec le lien',
        prose:
          "Camille, je lis seulement les courriels d'activités pour enfants, je n'envoie rien à ta place, et tu peux déconnecter quand tu veux. Tu veux que je surveille les dates d'inscription?",
        link: GMAIL_LINK,
        input: input({
          step: 'email',
          language: 'fr',
          parentWords: 'Camille',
          parentName: 'Camille',
          findLines: [NATATION, CONTE],
        }),
      },
      {
        title: 'calendrier avec le lien',
        prose:
          "Même chose pour le calendrier: je le lis, je n'écris rien sans ton oui, et tu peux déconnecter quand tu veux. Tu veux que je compare la natation à ton calendrier?",
        link: CALENDAR_LINK,
        input: input({
          step: 'calendar',
          language: 'fr',
          parentWords: "c'est fait",
          parentName: 'Camille',
          activity: 'Natation',
          findLines: [NATATION, CONTE],
        }),
      },
    ],
  },
  {
    id: 'en-everything-first',
    title: 'Parent gives kids, ages, and a postal code in the first text',
    turns: [
      {
        title: 'straight to the map, no question',
        prose: 'Maya is 4 and Leo is 1, near M6J. Here is what is on.',
        groupLeads: ['Weekends'],
        input: input({
          step: 'find_show',
          introduce: true,
          parentWords: "Hey, Maya is 4, Leo is 1, we're in M6J 1A1",
          placeLabel: 'M6J',
          agesLabel: 'a 4-year-old and a 1-year-old',
          ageMonths: [48, 12],
          findLines: [SWIM],
          findGroups: [{ category: 'weekend', lines: [SWIM] }],
          listKind: 'year',
        }),
      },
      {
        title: 'the name, in the second message',
        prose: "I'm Hale, by the way. What should I call you?",
        input: input({
          step: 'names',
          parentWords: "Hey, Maya is 4, Leo is 1, we're in M6J 1A1",
          placeLabel: 'M6J',
          findLines: [SWIM],
        }),
      },
      {
        title: 'gmail link on its own turn',
        prose:
          'Dana, this link is just for you. I read kid-activity mail only, never send for you, and you can disconnect any time. Want me to watch school and camp email for the dates?',
        link: GMAIL_LINK,
        input: input({
          step: 'email',
          parentWords: 'Dana',
          parentName: 'Dana',
          placeLabel: 'M6J',
          findLines: [SWIM],
        }),
      },
    ],
  },
];

/** The judged text for a turn: the find_show bubbles joined, or the one body. */
export function fixtureBody(turn: FriendFixtureTurn): string {
  if (turn.input.step === 'find_show') {
    return assembleFindShowBubbles(
      turn.prose,
      turn.input.findGroups ?? [],
      turn.groupLeads ?? null,
    ).join('\n\n');
  }
  return assembleFriendBody(turn.prose, turn.input, turn.link ?? null);
}
