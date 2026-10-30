import { describe, expect, it } from 'vitest';
import {
  type GroupPlanReportInput,
  groupPlanReportEnabled,
  groupPlanReportInput,
  groupPlanReportMessages,
  groupPlanReportRefusals,
  groupPlanReportUserMessage,
  planEndLabel,
  planWhenLabel,
} from './report';

/**
 * VIL-443 (T17) 1/2 — the facts code hands the group-text skill, and the structural
 * gates over what comes back. No model here (rule #8): the skill is judged in the eval.
 */

const EVENT = {
  title: 'Swim lesson',
  starts: 'Sat, Nov 7, 10:00 AM',
  ends: '11:00 AM',
  where: 'Riverside Y, 120 Main St, Toronto',
};
const LINK = 'https://app.villagehale.com/api/ics/event/0b6f.c2ln';
const MEMBERS = [
  { userId: 'u-ana', firstName: 'Ana' },
  { userId: 'u-sam', firstName: 'Sam' },
  { userId: 'u-rosa', firstName: 'Rosa' },
  { userId: 'u-unnamed', firstName: null },
];

function input(over: Partial<GroupPlanReportInput> = {}): GroupPlanReportInput {
  return {
    change: 'added',
    event: EVENT,
    onCalendarOf: ['Sam'],
    notYet: ['Ana', 'Rosa'],
    othersNotYet: 1,
    everyone: false,
    link: LINK,
    language: 'en',
    ...over,
  };
}

describe('VIL-443 groupPlanReportInput', () => {
  it('splits the group into whose calendar it reached and who it is not on yet', () => {
    expect(
      groupPlanReportInput({
        change: 'added',
        event: EVENT,
        members: MEMBERS,
        reachedUserIds: ['u-sam'],
        link: LINK,
        language: 'en',
      }),
    ).toEqual(input());
  });

  it('says everyone only when every member was reached', () => {
    const all = groupPlanReportInput({
      change: 'added',
      event: EVENT,
      members: MEMBERS.slice(0, 2),
      reachedUserIds: ['u-ana', 'u-sam'],
      link: LINK,
      language: 'en',
    });
    expect(all).toMatchObject({ everyone: true, notYet: [], othersNotYet: 0 });

    const unnamedMissing = groupPlanReportInput({
      change: 'added',
      event: EVENT,
      members: MEMBERS,
      reachedUserIds: ['u-ana', 'u-sam', 'u-rosa'],
      link: LINK,
      language: 'en',
    });
    expect(unnamedMissing).toMatchObject({ everyone: false, notYet: [], othersNotYet: 1 });
  });

  it('never says everyone about a group it knows nobody in', () => {
    const empty = groupPlanReportInput({
      change: 'added',
      event: EVENT,
      members: [],
      reachedUserIds: [],
      link: LINK,
      language: 'en',
    });
    expect(empty).toMatchObject({ everyone: false, onCalendarOf: [], notYet: [] });
  });

  it('collapses a repeated first name', () => {
    const twice = groupPlanReportInput({
      change: 'added',
      event: EVENT,
      members: [
        { userId: 'a', firstName: 'Sam' },
        { userId: 'b', firstName: 'Sam' },
      ],
      reachedUserIds: [],
      link: LINK,
      language: 'en',
    });
    expect(twice?.notYet).toEqual(['Sam']);
  });

  it('names nobody and carries no link on a cancel', () => {
    const cancelled = groupPlanReportInput({
      change: 'cancelled',
      event: EVENT,
      members: MEMBERS,
      reachedUserIds: ['u-sam'],
      link: LINK,
      language: 'fr',
    });
    expect(cancelled).toEqual({
      change: 'cancelled',
      event: EVENT,
      onCalendarOf: [],
      notYet: [],
      othersNotYet: 0,
      everyone: false,
      link: null,
      language: 'fr',
    });
  });

  it('refuses a placement or move with no link to give', () => {
    for (const change of ['added', 'moved'] as const) {
      expect(
        groupPlanReportInput({
          change,
          event: EVENT,
          members: MEMBERS,
          reachedUserIds: [],
          link: null,
          language: 'en',
        }),
      ).toBeNull();
    }
  });
});

describe('VIL-443 groupPlanReportRefusals (the link only, never wording)', () => {
  it('passes a text that carries the link once, even with closing punctuation', () => {
    expect(
      groupPlanReportRefusals([`Swim is set for Saturday. Add it here: ${LINK}.`], input()),
    ).toEqual([]);
  });

  it('refuses a draft with nothing to send', () => {
    expect(groupPlanReportRefusals([], input())).toEqual(['empty']);
    expect(groupPlanReportRefusals(['   ', ''], input())).toEqual(['empty']);
  });

  it('requires the handed link exactly once and no other link', () => {
    expect(groupPlanReportRefusals(['Swim is set for Saturday.'], input())).toContain(
      'link_missing',
    );
    expect(groupPlanReportRefusals([`${LINK} and again ${LINK}`], input())).toContain(
      'link_repeated',
    );
    expect(groupPlanReportRefusals([`Add it: ${LINK} or https://evil.test/x`], input())).toContain(
      'other_link',
    );
  });

  it('reads the link across a few messages: once, in the last of them', () => {
    expect(
      groupPlanReportRefusals(
        ['Swim is set for Saturday, 10 to 11, at the Riverside Y.', `Add it here: ${LINK}`],
        input(),
      ),
    ).toEqual([]);
    expect(
      groupPlanReportRefusals(
        [`Swim is set. Add it here: ${LINK}`, 'It runs 10 to 11 at the Riverside Y.'],
        input(),
      ),
    ).toEqual(['link_not_last']);
    expect(groupPlanReportRefusals([`Add it: ${LINK}`, `Or here: ${LINK}`], input())).toEqual([
      'link_repeated',
    ]);
    expect(
      groupPlanReportRefusals(['Swim is set.', 'See you there: https://evil.test/x'], input()),
    ).toEqual(['link_missing', 'other_link']);
  });

  it('refuses any link on a cancel', () => {
    const cancelled = input({ change: 'cancelled', link: null, onCalendarOf: [], notYet: [] });
    expect(groupPlanReportRefusals(['Swim is off.'], cancelled)).toEqual([]);
    expect(groupPlanReportRefusals(['Swim is off.', LINK], cancelled)).toEqual(['carries_link']);
  });

  it('leaves length, how many messages, punctuation and emoji to the judge', () => {
    const long = 'Swim is set for Saturday at the Y. '.repeat(20);
    expect(groupPlanReportRefusals([`${long}Add it: ${LINK}`], input())).toEqual([]);
    expect(
      groupPlanReportRefusals(['Swim!', 'Saturday.', '10 to 11.', 'The Y.', LINK], input()),
    ).toEqual([]);
    for (const text of [
      `Can you all make it? ${LINK}`,
      `Vous venez？ ${LINK}`,
      `¡Listo! 🎉 ${LINK}`,
    ]) {
      expect(groupPlanReportRefusals([text], input())).toEqual([]);
    }
  });

  it('reads a handed link with a query string as the handed link', () => {
    const queried = `${LINK}?v=2`;
    expect(groupPlanReportRefusals([`Add it: ${queried}`], input({ link: queried }))).toEqual([]);
  });
});

describe('VIL-443 groupPlanReportMessages', () => {
  it('keeps the order, trims each message and drops a blank one', () => {
    expect(groupPlanReportMessages(['  Swim is set. ', '', '\n', `Add it: ${LINK}`])).toEqual([
      'Swim is set.',
      `Add it: ${LINK}`,
    ]);
  });
});

describe('VIL-443 the user turn', () => {
  it('is the input alone on a first attempt', () => {
    expect(JSON.parse(groupPlanReportUserMessage(input()))).toEqual(input());
  });

  it('carries what the last draft got wrong on a retry', () => {
    const retry = JSON.parse(groupPlanReportUserMessage(input(), ['link_missing']));
    expect(retry.lastDraftRefused).toEqual(['link_missing']);
  });
});

describe('VIL-443 flag and time labels', () => {
  it('is off unless exactly true', () => {
    expect(groupPlanReportEnabled({})).toBe(false);
    expect(groupPlanReportEnabled({ GROUP_PLAN_CALENDAR_REPORT_ENABLED: 'yes' })).toBe(false);
    expect(groupPlanReportEnabled({ GROUP_PLAN_CALENDAR_REPORT_ENABLED: 'TRUE' })).toBe(false);
    expect(groupPlanReportEnabled({ GROUP_PLAN_CALENDAR_REPORT_ENABLED: ' true ' })).toBe(true);
  });

  it("renders the time in the family's zone and language", () => {
    const startsAt = new Date('2026-11-07T15:00:00.000Z');
    const en = planWhenLabel(startsAt, 'America/Toronto', 'en');
    expect(en).toMatch(/Sat/);
    expect(en).toMatch(/Nov/);
    expect(en).toMatch(/10:00/);
    const fr = planWhenLabel(startsAt, 'America/Toronto', 'fr');
    expect(fr).toMatch(/nov/);
    expect(fr).toMatch(/10( h |:)00/);
    expect(planWhenLabel(startsAt, 'UTC', 'en')).toMatch(/3:00/);
  });

  it('gives the end as the time alone when it ends the day it starts', () => {
    const startsAt = new Date('2026-11-07T15:00:00.000Z');
    const endsAt = new Date('2026-11-07T16:00:00.000Z');
    const en = planEndLabel(startsAt, endsAt, 'America/Toronto', 'en');
    expect(en).toMatch(/11:00/);
    expect(en).not.toMatch(/Sat|Nov/);
    expect(planEndLabel(startsAt, endsAt, 'America/Toronto', 'fr')).toMatch(/11( h |:)00/);
  });

  it("gives the day too when it runs past the day it starts, in the family's zone", () => {
    // 18:00 to 20:00 in Toronto is one evening, though it crosses midnight in UTC.
    const evening = new Date('2026-11-07T23:00:00.000Z');
    const sameNight = new Date('2026-11-08T01:00:00.000Z');
    expect(planEndLabel(evening, sameNight, 'America/Toronto', 'en')).not.toMatch(/Sat|Sun/);
    // 23:00 to 00:30 in Toronto does run into Sunday.
    const late = new Date('2026-11-08T04:00:00.000Z');
    const pastMidnight = new Date('2026-11-08T05:30:00.000Z');
    const next = planEndLabel(late, pastMidnight, 'America/Toronto', 'en');
    expect(next).toMatch(/Sun/);
    expect(next).toMatch(/12:30/);
  });

  it('says no end when the row holds none, or one that is not after the start', () => {
    const startsAt = new Date('2026-11-07T15:00:00.000Z');
    expect(planEndLabel(startsAt, null, 'America/Toronto', 'en')).toBeNull();
    expect(planEndLabel(startsAt, startsAt, 'America/Toronto', 'en')).toBeNull();
    expect(
      planEndLabel(startsAt, new Date('2026-11-07T14:00:00.000Z'), 'America/Toronto', 'en'),
    ).toBeNull();
  });
});
