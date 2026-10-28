import { describe, expect, it } from 'vitest';
import {
  unansweredMembers,
  winningOption,
  planFacts,
  optionsFromPicks,
  fakeGroupPlanFinder,
  fakeGroupPlanReader,
} from './group-plan';

const OPTIONS = [
  {
    id: '1',
    name: 'Saturday parent-and-tot swim',
    when: 'Saturdays 9:15am',
    where: 'Elm rec centre',
    price: '$8 drop-in',
    link: 'https://example.test/elm-swim',
  },
  {
    id: '2',
    name: 'Sunday family swim',
    when: 'Sundays 11am',
    where: 'Riverside pool',
    price: '$12',
    link: 'https://example.test/riverside',
  },
];

describe('VIL-441 plan together (pure)', () => {
  it('names seated members who have not answered', () => {
    expect(
      unansweredMembers(
        [
          { userId: 'priya', name: 'Priya' },
          { userId: 'jordan', name: 'Jordan' },
          { userId: 'mei', name: 'Mei' },
        ],
        [
          { userId: 'priya', seated: 'yes' },
          { userId: 'stranger', seated: 'no' },
        ],
      ).map((row) => row.name),
    ).toEqual(['Jordan', 'Mei']);
  });

  it('does not count a non-member yes toward the winning option', () => {
    expect(
      winningOption(OPTIONS, [
        { seated: 'no', stance: 'yes', optionId: '1' },
        { seated: 'yes', stance: 'yes', optionId: '2' },
      ])?.id,
    ).toBe('2');
  });

  it('facts carry options, who answered, and the deadline — nothing invented', () => {
    const facts = planFacts({
      topic: 'saturday swim',
      options: OPTIONS,
      deadline: '2026-10-30T16:00:00.000Z',
      yes: ['Priya'],
      no: [],
      maybe: ['Mei'],
      unanswered: ['Jordan'],
      winning: null,
    });
    expect(facts.options).toContain('Saturday parent-and-tot swim');
    expect(facts.options).toContain('https://example.test/elm-swim');
    expect(facts.unanswered).toBe('Jordan');
    expect(facts.deadline).toBe('2026-10-30T16:00:00.000Z');
    expect(facts.winning).toBe('');
  });

  it('maps finder picks onto option facts without filling gaps', () => {
    expect(
      optionsFromPicks([
        {
          name: 'Elm swim',
          when: null,
          price: null,
          sourceName: 'Elm rec centre',
          url: 'https://example.test/elm-swim',
        },
      ]),
    ).toEqual([
      {
        id: '1',
        name: 'Elm swim',
        when: null,
        where: 'Elm rec centre',
        price: null,
        link: 'https://example.test/elm-swim',
      },
    ]);
  });

  it('the fake finder never searches and names an empty result', async () => {
    const empty = fakeGroupPlanFinder({ found: false, reason: 'not_configured' });
    expect(await empty.find({ subject: 'swim', familyId: 'f1' })).toEqual({
      found: false,
      reason: 'not_configured',
    });
    expect(empty.calls).toHaveLength(1);
  });

  it('the fake reader is a test seam, not a wording rule', async () => {
    const reader = fakeGroupPlanReader(({ reactionType }) =>
      reactionType === 'like'
        ? { intent: 'yes', optionId: null, subject: null, confidence: 'high' }
        : { intent: 'chatter', optionId: null, subject: null, confidence: 'high' },
    );
    expect((await reader.read({
      text: '',
      reactionType: 'like',
      senderName: 'Jordan',
      options: OPTIONS,
      answered: [],
    }))?.intent).toBe('yes');
    expect((await reader.read({
      text: 'lol',
      reactionType: null,
      senderName: 'Jordan',
      options: OPTIONS,
      answered: [],
    }))?.intent).toBe('chatter');
  });
});
