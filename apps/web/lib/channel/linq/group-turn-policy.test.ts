import { describe, expect, it } from 'vitest';
import { type GroupTurnDecision, decideGroupTurn } from './group-turn-policy';

/**
 * Group onboarding v2, §4: in the family group Hale answers when it is spoken to, and a
 * parent talking to the other parent is not a turn. Code decides before the coach runs.
 */

const KIDS = ['Maya', 'Léo'];

const CASES: ReadonlyArray<[string, GroupTurnDecision]> = [
  ['STOP', { route: 'keyword', keyword: 'stop' }],
  ['arret', { route: 'keyword', keyword: 'stop' }],
  ['HELP', { route: 'keyword', keyword: 'help' }],
  ['Hale, is swim still on tomorrow', { route: 'coach', reason: 'addressed' }],
  ['@Hale can you check saturday', { route: 'coach', reason: 'addressed' }],
  ['thanks hale!', { route: 'coach', reason: 'addressed' }],
  ['what time is Maya done tonight?', { route: 'coach', reason: 'question' }],
  ['léo a quelle heure demain?', { route: 'coach', reason: 'question' }],
  ["who's taking them to soccer?", { route: 'coach', reason: 'question' }],
  ['when is pickup on friday?', { route: 'coach', reason: 'question' }],
  ['qui prend les enfants jeudi?', { route: 'coach', reason: 'question' }],
  ["I'll take Maya to swim", { route: 'duty' }],
  ['je prends Léo mercredi', { route: 'duty' }],
  ['love you, see you tonight', { route: 'ignore', outcome: 'group_chatter_ignored' }],
  ['Maya was so funny at dinner', { route: 'ignore', outcome: 'group_chatter_ignored' }],
  ['did you buy milk?', { route: 'ignore', outcome: 'group_chatter_ignored' }],
  ['when is pickup on friday', { route: 'ignore', outcome: 'group_chatter_ignored' }],
  ['inhale, exhale', { route: 'ignore', outcome: 'group_chatter_ignored' }],
  ['Mayan ruins documentary tonight?', { route: 'ignore', outcome: 'group_chatter_ignored' }],
  ['', { route: 'ignore', outcome: 'group_chatter_ignored' }],
];

describe('decideGroupTurn', () => {
  for (const [text, expected] of CASES) {
    it(`decides ${JSON.stringify(text)}`, () => {
      expect(decideGroupTurn({ text, kidNames: KIDS })).toEqual(expected);
    });
  }

  it('reads a kid name only when the family has that kid', () => {
    expect(decideGroupTurn({ text: 'is Maya done at 5?', kidNames: KIDS })).toEqual({
      route: 'coach',
      reason: 'question',
    });
    expect(decideGroupTurn({ text: 'is Maya done at 5?', kidNames: [] })).toEqual({
      route: 'ignore',
      outcome: 'group_chatter_ignored',
    });
  });

  it('treats a kid name with regex characters as plain text', () => {
    expect(decideGroupTurn({ text: 'is A.J. done?', kidNames: ['A.J.'] })).toEqual({
      route: 'coach',
      reason: 'question',
    });
    expect(decideGroupTurn({ text: 'is AxJx done?', kidNames: ['A.J.'] })).toEqual({
      route: 'ignore',
      outcome: 'group_chatter_ignored',
    });
  });
});
