import { describe, expect, it } from 'vitest';
import { type ReplyCopyCheck, validateReplyCopy } from './validate';

/**
 * Each validator rule, the four sample replies, and the digit exception:
 * a digit that arrived in the facts may stay. A digit the model added may not.
 */

const RECALL =
  'Here\'s what I have: Maya is 4, you\'re near L3R, and I think soccer is her thing for now. Wrong or old? Say "correct" or "forget" and the key.';
const FORGOT = 'Done, I forgot the soccer note. Say "what do you know" any time to see the rest.';
const ASK = "Nobody has Theo's swim on Saturday at 9 yet. Who's taking it?";
const NIGHT = "Tomorrow: Sam has Theo's swim at 9. Say so here if that changes.";

function check(over: Partial<ReplyCopyCheck> = {}): ReplyCopyCheck {
  return {
    language: 'en',
    facts: [],
    audience: 'direct',
    questionAllowed: true,
    role: 'prose',
    ...over,
  };
}

describe('reply copy samples', () => {
  it('accepts the recall, the forget confirmation, the open ask, and the night-before line', () => {
    expect(
      validateReplyCopy(
        RECALL,
        check({ facts: ['Maya', '4', 'L3R', 'soccer'], questionAllowed: true }),
      ),
    ).toBeNull();
    expect(
      validateReplyCopy(FORGOT, check({ facts: ['soccer'], questionAllowed: false })),
    ).toBeNull();
    expect(
      validateReplyCopy(
        ASK,
        check({
          facts: ['Theo', 'swim', 'Saturday', '9'],
          audience: 'group',
          questionAllowed: true,
        }),
      ),
    ).toBeNull();
    expect(
      validateReplyCopy(
        NIGHT,
        check({
          facts: ['Tomorrow', 'Sam', 'Theo', 'swim', '9'],
          audience: 'group',
          questionAllowed: false,
        }),
      ),
    ).toBeNull();
  });

  it('accepts a confirmation that ends with Nothing to do.', () => {
    expect(validateReplyCopy('Nothing to do.', check({ questionAllowed: false }))).toBeNull();
    expect(
      validateReplyCopy('Rien a faire.', check({ language: 'fr', questionAllowed: false })),
    ).toBeNull();
  });

  it('keeps a digit that was in the facts and rejects one that was not', () => {
    expect(validateReplyCopy(ASK, check({ facts: ['Theo', 'swim', 'Saturday', '9'] }))).toBeNull();
    expect(
      validateReplyCopy(
        "Nobody has Theo's swim on Saturday at 10 yet. Who's taking it?",
        check({ facts: ['Theo', 'swim', 'Saturday', '9'] }),
      ),
    ).toBe('digit');
  });
});

describe('reply copy validator rules', () => {
  it('rejects an empty reply', () => {
    expect(validateReplyCopy('   ', check())).toBe('empty');
  });

  it('rejects more than 320 characters', () => {
    expect(validateReplyCopy(`${'a'.repeat(321)}`, check())).toBe('length');
  });

  it('rejects a reply in the other language, and a French reply that is not ASCII', () => {
    expect(
      validateReplyCopy('Voici la famille. Dites-le ici si ca change.', check({ language: 'en' })),
    ).toBe('language');
    expect(
      validateReplyCopy(ASK, check({ facts: ['Theo', 'swim', 'Saturday', '9'], language: 'fr' })),
    ).toBe('language');
    expect(
      validateReplyCopy("C'est déjà fait. Dites-le ici si ca change.", check({ language: 'fr' })),
    ).toBe('language');
    expect(
      validateReplyCopy(
        "Demain Sam s'occupe de la natation. Dites-le ici si ca change.",
        check({
          language: 'fr',
          facts: ['Demain', 'Sam', 'natation'],
          questionAllowed: false,
        }),
      ),
    ).toBeNull();
  });

  it.each([
    'booked',
    'enrolled',
    'signed up',
    'registered',
    'STOP',
    'unsubscribe',
    'AI',
    'automation',
  ])('rejects the banned word %s', (word) => {
    const text = `Done, I saw ${word} on the soccer note. Say "what do you know" any time to see the rest.`;
    expect(validateReplyCopy(text, check({ facts: ['soccer'], questionAllowed: false }))).toBe(
      'banned',
    );
  });

  it('rejects a second question mark, and any question the ask budget did not allow', () => {
    expect(validateReplyCopy("Who has it? Who's taking it?", check())).toBe('question');
    expect(
      validateReplyCopy(
        ASK,
        check({ facts: ['Theo', 'swim', 'Saturday', '9'], questionAllowed: false }),
      ),
    ).toBe('question');
  });

  it('rejects a reply that does not end in one next step', () => {
    expect(
      validateReplyCopy(
        'Theo has swim at 9 on Saturday.',
        check({ facts: ['Theo', 'swim', '9', 'Saturday'], questionAllowed: false }),
      ),
    ).toBe('next_step');
    expect(
      validateReplyCopy(
        'Theo has swim. Sam has it too. Say so here if that changes.',
        check({ facts: ['Theo', 'Sam', 'swim'], questionAllowed: false }),
      ),
    ).toBe('next_step');
  });

  it('rejects a place that was not in the facts', () => {
    expect(
      validateReplyCopy(
        "Nobody has Theo's swim on Saturday at 9 yet. Who's taking it?",
        check({ facts: ['Theo', 'swim', '9'] }),
      ),
    ).toBe('place');
    expect(
      validateReplyCopy(
        "Nobody has Theo's swim near L3R on Saturday at 9 yet. Who's taking it?",
        check({ facts: ['Theo', 'swim', 'Saturday', '9', '3'] }),
      ),
    ).toBe('place');
  });

  it('rejects a name that was not in the facts', () => {
    expect(
      validateReplyCopy(
        "Nobody has Theo's swim with Priya on Saturday at 9 yet. Who's taking it?",
        check({ facts: ['Theo', 'swim', 'Saturday', '9'] }),
      ),
    ).toBe('name');
  });

  it('rejects a remembered value in a group message', () => {
    expect(
      validateReplyCopy(
        ASK,
        check({
          facts: ['Theo', 'swim', 'Saturday', '9'],
          audience: 'group',
          sealedValues: ['Theo'],
        }),
      ),
    ).toBe('group_memory');
    expect(
      validateReplyCopy(
        ASK,
        check({
          facts: ['Theo', 'swim', 'Saturday', '9'],
          audience: 'direct',
          sealedValues: ['Theo'],
        }),
      ),
    ).toBeNull();
  });
});
