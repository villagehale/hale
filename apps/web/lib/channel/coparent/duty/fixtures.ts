import type { DutyRole } from './model';
import type { DutyClaimKind, DutyParseInput } from './parse';

/**
 * VIL-381 eval set. Slot accuracy is measured in parse.eval.test.ts.
 * Barton can move the floor; the cases stay.
 */

/** Barton can change this. The fixture set is the gate. */
export const DUTY_SLOT_ACCURACY_FLOOR = 0.9;

export interface DutyFixtureSlot {
  role: DutyRole;
  claim: DutyClaimKind;
  name?: string;
  userId?: string;
}

export interface DutyFixture {
  id: string;
  text: string;
  tapback?: string | null;
  speakerUserId?: string;
  askedRole?: DutyRole | null;
  childNames?: readonly string[];
  eventTitle?: string | null;
  /** When rules return none, the fixture extractor returns this parse. */
  llm?: {
    question?: boolean;
    confidence: number;
    slots: Array<{
      role: DutyRole;
      claim: DutyClaimKind | 'unclear';
      name: string | null;
      confidence: number;
    }>;
  };
  expect: {
    write: boolean;
    question: boolean;
    askWhichKid: boolean;
    slots: DutyFixtureSlot[];
  };
}

const MAYA = ['Maya'] as const;
const SIBLINGS = ['Maya', 'Leo'] as const;

function fixture(
  id: string,
  text: string,
  slots: DutyFixtureSlot[],
  extra: Partial<Omit<DutyFixture, 'id' | 'text' | 'expect'>> & {
    expect?: Partial<DutyFixture['expect']>;
  } = {},
): DutyFixture {
  return {
    id,
    text,
    speakerUserId: extra.speakerUserId,
    tapback: extra.tapback,
    askedRole: extra.askedRole,
    childNames: extra.childNames ?? MAYA,
    eventTitle: extra.eventTitle === undefined ? 'Maya swim' : extra.eventTitle,
    llm: extra.llm,
    expect: {
      write: extra.expect?.write ?? true,
      question: extra.expect?.question ?? false,
      askWhichKid: extra.expect?.askWhichKid ?? false,
      slots,
    },
  };
}

const self = (role: DutyRole): DutyFixtureSlot => ({ role, claim: 'self', userId: 'a' });

export const DUTY_FIXTURES: readonly DutyFixture[] = [
  fixture('me', 'me', [self('attend')]),
  fixture('ill-take', "I'll take it", [self('attend')]),
  fixture('i-got-it', 'I got it', [self('attend')]),
  fixture('ive-got-it', "I've got it", [self('attend')]),
  fixture('i-can', 'I can do it', [self('attend')]),
  fixture('cest-moi', "c'est moi", [self('attend')]),
  fixture('je-men-occupe', "je m'en occupe", [self('attend')]),
  fixture('mine', 'mine', [self('attend')]),
  fixture('pickup-self', "I'll do pickup", [self('pickup')]),
  fixture('dropoff-self', 'I can drop off', [self('dropoff')]),
  fixture('neither', 'neither', [{ role: 'attend', claim: 'neither' }]),
  fixture('neither-of-us', 'neither of us', [{ role: 'attend', claim: 'neither' }]),
  fixture('figure-it-out', "We'll figure it out", [{ role: 'attend', claim: 'neither' }]),
  fixture('on-verra', 'On verra', [{ role: 'attend', claim: 'neither' }]),
  fixture('nobody', 'nobody can', [{ role: 'attend', claim: 'neither' }]),
  fixture('ni-lun', "ni l'un ni l'autre", [{ role: 'attend', claim: 'neither' }]),
  fixture('pickup-not-dropoff', 'pickup not dropoff', [
    self('pickup'),
    { role: 'dropoff', claim: 'not_me', userId: 'a' },
  ]),
  fixture('pickup-but-not', "I'll do pickup but not dropoff", [
    self('pickup'),
    { role: 'dropoff', claim: 'not_me', userId: 'a' },
  ]),
  fixture('pick-up-comma', 'I can pick up, not drop-off', [
    self('pickup'),
    { role: 'dropoff', claim: 'not_me', userId: 'a' },
  ]),
  fixture('both', 'both', [{ role: 'attend', claim: 'both' }]),
  fixture('both-of-us', 'both of us', [{ role: 'attend', claim: 'both' }]),
  fixture('well-both-go', "we'll both go", [{ role: 'attend', claim: 'both' }]),
  fixture('both-attend', 'we can both attend', [{ role: 'attend', claim: 'both' }]),
  fixture('les-deux', 'les deux', [{ role: 'attend', claim: 'both' }]),
  fixture('maybe', 'maybe', [{ role: 'attend', claim: 'maybe', userId: 'a' }]),
  fixture('not-sure', 'not sure', [{ role: 'attend', claim: 'maybe', userId: 'a' }]),
  fixture('i-might', 'I might', [{ role: 'attend', claim: 'maybe', userId: 'a' }]),
  fixture('peut-etre', 'peut-etre', [{ role: 'attend', claim: 'maybe', userId: 'a' }]),
  fixture('possibly', 'possibly', [{ role: 'attend', claim: 'maybe', userId: 'a' }]),
  fixture('question-who', "who's taking it?", [], { expect: { write: false, question: true } }),
  fixture('question-can-you', 'can you do pickup?', [], {
    expect: { write: false, question: true },
  }),
  fixture('question-maybe', 'maybe?', [], { expect: { write: false, question: true } }),
  fixture('question-which', 'which kid?', [], { expect: { write: false, question: true } }),
  fixture('tap-love', '', [self('attend')], { tapback: 'love' }),
  fixture('tap-like', '', [self('attend')], { tapback: 'like' }),
  fixture('tap-emphasize', '', [self('attend')], { tapback: 'emphasize' }),
  fixture('tap-dislike', '', [{ role: 'attend', claim: 'not_me', userId: 'a' }], {
    tapback: 'dislike',
  }),
  fixture('tap-question', '', [], {
    tapback: 'question',
    expect: { write: false, question: true },
  }),
  fixture('tap-laugh', '', [], { tapback: 'laugh', expect: { write: false, question: false } }),
  fixture('grandma-pickup', 'Grandma is picking up', [
    { role: 'pickup', claim: 'named', name: 'Grandma' },
  ]),
  fixture('grandma-dropoff', 'Grandma will drop off', [
    { role: 'dropoff', claim: 'named', name: 'Grandma' },
  ]),
  fixture('nana-pickup', "Nana's got pickup", [{ role: 'pickup', claim: 'named', name: 'Nana' }]),
  fixture('sam-will-take', 'Sam will take it', [
    { role: 'attend', claim: 'other_parent', name: 'Sam', userId: 'b' },
  ]),
  fixture('you-dropoff', 'you take dropoff', [
    { role: 'dropoff', claim: 'other_parent', name: 'Sam', userId: 'b' },
  ]),
  fixture('which-kid', "I'll take it", [self('attend')], {
    childNames: SIBLINGS,
    eventTitle: 'swim class',
    expect: { write: false, askWhichKid: true },
  }),
  fixture('not-me', 'not me', [{ role: 'attend', claim: 'not_me', userId: 'a' }]),
  fixture('morning-handoff', 'the morning handoff is on me', [self('dropoff')], {
    llm: {
      confidence: 0.85,
      slots: [{ role: 'dropoff', claim: 'self', name: null, confidence: 0.85 }],
    },
  }),
  fixture(
    'nana-later-low',
    "nana's probably fine for later",
    [{ role: 'pickup', claim: 'named', name: 'Nana' }],
    {
      llm: {
        confidence: 0.4,
        slots: [{ role: 'pickup', claim: 'named', name: 'Nana', confidence: 0.4 }],
      },
      expect: { write: false },
    },
  ),
];

export function fixtureInput(row: DutyFixture): DutyParseInput {
  return {
    text: row.text,
    tapback: row.tapback,
    speakerUserId: row.speakerUserId ?? 'a',
    parents: [
      { userId: 'a', name: 'Barton' },
      { userId: 'b', name: 'Sam' },
    ],
    askedRole: row.askedRole,
    childNames: row.childNames,
    eventTitle: row.eventTitle,
  };
}
