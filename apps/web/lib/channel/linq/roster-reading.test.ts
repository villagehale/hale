import { describe, expect, it } from 'vitest';
import { type RosterReading, readRosterReply } from './roster-reading';

/**
 * Group onboarding v2: a member's own reply to "who are you in this family". Code reads
 * the clear cases; anything it cannot read is `unclear`, never a guess.
 */

type Expected =
  | { role: 'parent'; parentRole: 'mother' | 'father' | null }
  | { role: 'grandparent' | 'nanny' | 'babysitter' | 'not_family' | 'decline' }
  | 'unclear';

const REPLIES: ReadonlyArray<[string, Expected]> = [
  ["I'm his dad", { role: 'parent', parentRole: 'father' }],
  ['Mom here', { role: 'parent', parentRole: 'mother' }],
  ['MUM', { role: 'parent', parentRole: 'mother' }],
  ["c'est maman", { role: 'parent', parentRole: 'mother' }],
  ['Je suis le papa', { role: 'parent', parentRole: 'father' }],
  ["I'm the other parent", { role: 'parent', parentRole: null }],
  ['grandma here!', { role: 'grandparent' }],
  ['Grandpa', { role: 'grandparent' }],
  ["C'est mamie", { role: 'grandparent' }],
  ['la grand-mère', { role: 'grandparent' }],
  ['Je suis le grand-papa', { role: 'grandparent' }],
  ["I'm their grandmother", { role: 'grandparent' }],
  ['nanny :)', { role: 'nanny' }],
  ['Je suis la nounou', { role: 'nanny' }],
  ['the au pair', { role: 'nanny' }],
  ['babysitter', { role: 'babysitter' }],
  ["I'm the sitter on weekends", { role: 'babysitter' }],
  ['la gardienne', { role: 'babysitter' }],
  ['not family, just a friend', { role: 'not_family' }],
  ['pas de la famille', { role: 'not_family' }],
  ["I'm the aunt", { role: 'not_family' }],
  ['leave me out', { role: 'decline' }],
  ['non merci', { role: 'decline' }],
  ['no', { role: 'decline' }],
  ["it's me lol", 'unclear'],
  ['yes', 'unclear'],
  ["I'm not the mom, I'm the nanny", 'unclear'],
  ['stepdad', 'unclear'],
  ['mom or dad?', 'unclear'],
  ['Bonjour !', 'unclear'],
];

function shape(reading: RosterReading): Expected {
  if (reading.kind === 'unclear') return 'unclear';
  if (reading.role === 'parent') return { role: 'parent', parentRole: reading.parentRole };
  return { role: reading.role };
}

describe('readRosterReply', () => {
  it('has thirty replies, in English and French', () => {
    expect(REPLIES).toHaveLength(30);
  });

  for (const [text, expected] of REPLIES) {
    it(`reads ${JSON.stringify(text)}`, () => {
      expect(shape(readRosterReply(text))).toEqual(expected);
    });
  }

  it('never reads an in-law, or someone else’s parent, as a parent', () => {
    for (const text of [
      "I'm their mother-in-law",
      'father in law here',
      "their dad's girlfriend",
      "the kids' mom's friend",
      'la copine du papa',
      "l'amie de la maman",
      'their mom is at work rn',
      'their grandma is picking them up today',
    ]) {
      expect(readRosterReply(text)).toEqual({ kind: 'unclear' });
    }
  });

  it('never reads a grandparent word as a parent, whatever parent word it contains', () => {
    for (const text of ['grandma', 'Grand-maman', 'grand-mère', 'grandmother', 'grand papa']) {
      expect(readRosterReply(text)).toMatchObject({ kind: 'role', role: 'grandparent' });
    }
  });
});
