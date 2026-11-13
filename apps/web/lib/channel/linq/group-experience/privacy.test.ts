import { describe, expect, it } from 'vitest';
import { groupLineLeaksPrivate } from './privacy';

describe('groupLineLeaksPrivate', () => {
  it('refuses a line that repeats a deny-list string, in any case', () => {
    const deny = ['peanut allergy', 'Dentist checkup'];
    expect(groupLineLeaksPrivate('About that Peanut Allergy.', deny)).toBe(true);
    expect(groupLineLeaksPrivate('The dentist checkup clashes.', deny)).toBe(true);
  });

  it('positive control: a line with none of them goes through', () => {
    expect(groupLineLeaksPrivate('I will text you.', ['peanut allergy'])).toBe(false);
  });

  it('matches whole words, never a fragment of a longer word', () => {
    expect(groupLineLeaksPrivate('Available Saturday at 10.', ['Ava'])).toBe(false);
    expect(groupLineLeaksPrivate('The park plan is on.', ['Ark'])).toBe(false);
    expect(groupLineLeaksPrivate('Ava is coming.', ['Ava'])).toBe(true);
    expect(groupLineLeaksPrivate("Ava's coming.", ['Ava'])).toBe(true);
  });

  it('a name in a script written without spaces is still caught inside a sentence', () => {
    expect(groupLineLeaksPrivate('王小明今天去公园', ['王小明'])).toBe(true);
    expect(groupLineLeaksPrivate('今天去公园', ['王小明'])).toBe(false);
  });

  /**
   * VIL-689 · each spelling a private term can take in a group line, with its positive control:
   * the same line with the term replaced by an unrelated word goes through.
   */
  const EVASIONS: { row: string; line: string; control: string }[] = [
    { row: 'plain', line: 'Zephyrina is in.', control: 'Everyone is in.' },
    {
      row: 'possessive, straight',
      line: "Zephyrina's swim is at 4.",
      control: "Coach's swim is at 4.",
    },
    {
      row: 'possessive, curly',
      line: 'Zephyrina\u2019s swim is at 4.',
      control: 'Coach\u2019s swim is at 4.',
    },
    { row: 'hyphenated', line: 'Zephy-rina is in.', control: 'Twenty-one are in.' },
    { row: 'concatenated', line: 'ZephyrinaSwim moved.', control: 'SaturdaySwim moved.' },
    { row: 'zero-width', line: 'Zeph\u200byrina is in.', control: 'Every\u200bone is in.' },
    { row: 'soft hyphen', line: 'Zephy\u00adrina is in.', control: 'Every\u00adone is in.' },
    { row: 'spaced out', line: 'Z e p h y r i n a is in.', control: 'S w i m is at 4.' },
    { row: 'accents', line: 'Zéphyrina is in.', control: 'Café is open.' },
    { row: 'case and width', line: 'ＺＥＰＨＹＲＩＮＡ is in.', control: 'ＳＷＩＭ is at 4.' },
  ];

  for (const { row, line, control } of EVASIONS) {
    it(`a private term spelled ${row} is still refused; its control goes through`, () => {
      expect(groupLineLeaksPrivate(line, ['Zephyrina'])).toBe(true);
      expect(groupLineLeaksPrivate(control, ['Zephyrina'])).toBe(false);
    });
  }

  it('a multi-word private term run together or hyphenated is refused', () => {
    const deny = ['Maple Swim Club'];
    expect(groupLineLeaksPrivate('See you at MapleSwimClub.', deny)).toBe(true);
    expect(groupLineLeaksPrivate('See you at maple-swim-club.', deny)).toBe(true);
    expect(groupLineLeaksPrivate('See you at the maple tree.', deny)).toBe(false);
  });

  it('a term under four letters stays whole-word: it never silences a longer word', () => {
    expect(groupLineLeaksPrivate('Avalanche drills Saturday.', ['Ava'])).toBe(false);
    expect(groupLineLeaksPrivate('Leopards play at 4.', ['Leo'])).toBe(false);
    expect(groupLineLeaksPrivate('Leo plays at 4.', ['Leo'])).toBe(true);
    expect(groupLineLeaksPrivate('Bo is in.', ['Bo'])).toBe(true);
    expect(groupLineLeaksPrivate('Bonfire at 7.', ['Bo'])).toBe(false);
  });

  it('a short term split by a zero-width character is still the whole word (M10)', () => {
    // Short terms are never joined across words, so only the format-character strip catches this.
    expect(groupLineLeaksPrivate('A\u200Bva is coming.', ['Ava'])).toBe(true);
    expect(groupLineLeaksPrivate('L\u2060eo plays at 4.', ['Leo'])).toBe(true);
    expect(groupLineLeaksPrivate('A\u200Bvalanche drills Saturday.', ['Ava'])).toBe(false);
  });
});
