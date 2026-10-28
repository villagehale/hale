import { describe, expect, it } from 'vitest';
import {
  type PlanExpectedRow,
  type PlanTallyRow,
  isMeaningfulTallyChange,
  planTallyFacts,
  tallyPlanRsvps,
} from './tally';

const row = (
  memberKey: string,
  displayName: string,
  response: PlanTallyRow['response'],
  headcount = 1,
  extras: Partial<Pick<PlanTallyRow, 'householdLabel' | 'coversKeys'>> = {},
): PlanTallyRow => ({
  memberKey,
  displayName,
  response,
  headcount,
  householdLabel: extras.householdLabel ?? null,
  coversKeys: extras.coversKeys ?? [],
});

const expected = (memberKey: string, displayName: string): PlanExpectedRow => ({
  memberKey,
  displayName,
});

describe('tallyPlanRsvps', () => {
  it('counts heads for yes, not replies — a family of four is four people', () => {
    const tally = tallyPlanRsvps(
      [row('priya', 'Priya', 'yes', 4), row('sam', 'Sam', 'yes', 2)],
      [],
    );
    expect(tally.yesCount).toBe(2);
    expect(tally.yesHeads).toBe(6);
    expect(tally.toGo).toBe(0);
  });

  it('keeps maybe separate and lists who is still waiting', () => {
    const tally = tallyPlanRsvps(
      [row('a', 'Asha', 'yes', 2), row('b', 'Ben', 'maybe', 3), row('c', 'Cam', 'no')],
      [expected('a', 'Asha'), expected('b', 'Ben'), expected('c', 'Cam'), expected('d', 'Dev')],
    );
    expect(tally.yesHeads).toBe(2);
    expect(tally.maybeHeads).toBe(3);
    expect(tally.noCount).toBe(1);
    expect(tally.waitingNames).toEqual(['Dev']);
    expect(tally.toGo).toBe(1);
  });

  it('an edit of the same member replaces the old answer — the count stays right', () => {
    const first = tallyPlanRsvps(
      [row('priya', 'Priya', 'yes', 4)],
      [expected('priya', 'Priya'), expected('sam', 'Sam')],
    );
    expect(first.yesHeads).toBe(4);
    expect(first.toGo).toBe(1);

    const afterEdit = tallyPlanRsvps(
      [row('priya', 'Priya', 'no', 1)],
      [expected('priya', 'Priya'), expected('sam', 'Sam')],
    );
    expect(afterEdit.yesHeads).toBe(0);
    expect(afterEdit.noCount).toBe(1);
    expect(afterEdit.toGo).toBe(1);
    expect(afterEdit.yesNames).toEqual([]);
    expect(afterEdit.noNames).toEqual(['Priya']);
  });

  it('a household answer covers the named people so they are not still waiting', () => {
    const tally = tallyPlanRsvps(
      [
        row('maya', 'Maya', 'yes', 3, {
          householdLabel: 'the Chens',
          coversKeys: ['wei', 'lin'],
        }),
      ],
      [
        expected('maya', 'Maya'),
        expected('wei', 'Wei'),
        expected('lin', 'Lin'),
        expected('sam', 'Sam'),
      ],
    );
    expect(tally.yesCount).toBe(1);
    expect(tally.yesHeads).toBe(3);
    expect(tally.yesNames).toEqual(['the Chens']);
    expect(tally.waitingNames).toEqual(['Sam']);
    expect(tally.toGo).toBe(1);
  });

  it('empty answers with expected people is all waiting — 0 yes, N to go', () => {
    const tally = tallyPlanRsvps([], [expected('a', 'Asha'), expected('b', 'Ben')]);
    expect(tally.yesCount).toBe(0);
    expect(tally.toGo).toBe(2);
    expect(tally.waitingNames).toEqual(['Asha', 'Ben']);
  });
});

describe('isMeaningfulTallyChange', () => {
  const empty = tallyPlanRsvps([], [expected('a', 'Asha'), expected('b', 'Ben')]);
  const oneYes = tallyPlanRsvps(
    [row('a', 'Asha', 'yes')],
    [expected('a', 'Asha'), expected('b', 'Ben')],
  );
  const done = tallyPlanRsvps(
    [row('a', 'Asha', 'yes'), row('b', 'Ben', 'yes')],
    [expected('a', 'Asha'), expected('b', 'Ben')],
  );

  it('speaks when tracking starts, when asked, or when an answer is edited', () => {
    expect(
      isMeaningfulTallyChange({
        intent: 'start_tracking',
        before: null,
        after: empty,
        householdAnswer: false,
      }),
    ).toBe(true);
    expect(
      isMeaningfulTallyChange({
        intent: 'ask_tally',
        before: oneYes,
        after: oneYes,
        householdAnswer: false,
      }),
    ).toBe(true);
    expect(
      isMeaningfulTallyChange({
        intent: 'edit',
        before: oneYes,
        after: empty,
        householdAnswer: false,
      }),
    ).toBe(true);
  });

  it('stays quiet on an ordinary yes that is not the last one', () => {
    expect(
      isMeaningfulTallyChange({
        intent: 'rsvp',
        before: empty,
        after: oneYes,
        householdAnswer: false,
      }),
    ).toBe(false);
  });

  it('speaks when a household answers or when nobody is left waiting', () => {
    expect(
      isMeaningfulTallyChange({
        intent: 'rsvp',
        before: empty,
        after: oneYes,
        householdAnswer: true,
      }),
    ).toBe(true);
    expect(
      isMeaningfulTallyChange({
        intent: 'rsvp',
        before: oneYes,
        after: done,
        householdAnswer: false,
      }),
    ).toBe(true);
  });

  it('never speaks for chatter', () => {
    expect(
      isMeaningfulTallyChange({
        intent: 'chatter',
        before: oneYes,
        after: oneYes,
        householdAnswer: false,
      }),
    ).toBe(false);
  });
});

describe('planTallyFacts', () => {
  it('hands the voice skill numbers and names, not a sentence', () => {
    const facts = planTallyFacts(
      tallyPlanRsvps(
        [row('priya', 'Priya', 'yes', 4)],
        [expected('priya', 'Priya'), expected('sam', 'Sam')],
      ),
    );
    expect(facts.yesCount).toBe(1);
    expect(facts.yesHeads).toBe(4);
    expect(facts.toGo).toBe(1);
    expect(facts.waitingNames).toEqual(['Sam']);
    expect(Object.keys(facts).sort()).toEqual(
      [
        'maybeCount',
        'maybeHeads',
        'maybeNames',
        'noCount',
        'noNames',
        'toGo',
        'waitingCount',
        'waitingNames',
        'yesCount',
        'yesHeads',
        'yesNames',
      ].sort(),
    );
  });
});
