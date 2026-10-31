import type { Skill } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { loadCronSkill } from '~/lib/cron/skill';
import {
  augmentCoachSkillForFindPrivate,
  narratesFindReasoning,
  nearbyFindTurn,
  withoutFindReasoning,
} from './find-private';

const BASE: Skill = {
  meta: { name: 'coach-channel-sms', whenToUse: 'x', task: 'converse', tools: [] },
  instructions: 'be terse',
};

describe('nearbyFindTurn', () => {
  it('is a nearby-find ask', () => {
    expect(nearbyFindTurn("what's on this weekend", [])).toBe(true);
    expect(nearbyFindTurn('what is on thursday', [])).toBe(true);
    expect(nearbyFindTurn('anything going on Saturday', [])).toBe(true);
    expect(nearbyFindTurn("who's around this weekend", [])).toBe(true);
    expect(nearbyFindTurn('trick or treat nearby', [])).toBe(true);
  });

  it('is not a calendar edit or a calendar read', () => {
    expect(nearbyFindTurn('move swim to tuesday', [])).toBe(false);
    expect(nearbyFindTurn('move swim to this weekend', [])).toBe(false);
    expect(nearbyFindTurn("what's on the calendar today", [])).toBe(false);
    expect(nearbyFindTurn('cancel piano', [])).toBe(false);
  });

  it('stays on for the turn right after a find ask', () => {
    const transcript = [{ role: 'user' as const, content: "what's on this weekend" }];
    expect(nearbyFindTurn('the library one', transcript)).toBe(true);
  });

  it('drops off when the next turn edits the calendar', () => {
    const transcript = [{ role: 'user' as const, content: "what's on this weekend" }];
    expect(nearbyFindTurn('move swim to tuesday', transcript)).toBe(false);
  });

  it('ignores the current ask when the transcript already ends with it', () => {
    const body = 'move swim to tuesday';
    expect(nearbyFindTurn(body, [{ role: 'user', content: body }])).toBe(false);
  });
});

describe('narratesFindReasoning', () => {
  it('catches the preview leak and the same kind of aside', () => {
    expect(narratesFindReasoning('All three finds share one page…')).toBe(true);
    expect(narratesFindReasoning('All three share one page.')).toBe(true);
    expect(narratesFindReasoning('Based on my search, these are the ones.')).toBe(true);
    expect(narratesFindReasoning("I'm ranking these for Saturday.")).toBe(true);
  });

  it('leaves a find the parent can use', () => {
    expect(narratesFindReasoning('EarlyON Saturday at 10 at the library suits Mia.')).toBe(false);
    expect(narratesFindReasoning('Storytime at 11, then the drop-in at 2.')).toBe(false);
  });
});

describe('withoutFindReasoning', () => {
  it('drops only the reasoning sentence', () => {
    expect(
      withoutFindReasoning(
        'All three finds share one page. EarlyON Saturday at 10. Storytime at 11.',
      ),
    ).toEqual({
      text: 'EarlyON Saturday at 10. Storytime at 11.',
      cut: 1,
    });
  });

  it('returns the same string when nothing narrates', () => {
    const body = 'EarlyON Saturday at 10. Storytime at 11.';
    expect(withoutFindReasoning(body)).toEqual({ text: body, cut: 0 });
  });

  it('leaves nothing when the reply is only the aside', () => {
    expect(withoutFindReasoning('All three finds share one page…')).toEqual({
      text: '',
      cut: 1,
    });
  });

  it('does not split 10 a.m. into its own sentence', () => {
    const body = 'EarlyON Saturday at 10 a.m. Storytime at 11.';
    expect(withoutFindReasoning(body)).toEqual({ text: body, cut: 0 });
  });

  it('keeps 10 a.m. on the find that stays', () => {
    expect(
      withoutFindReasoning('All three finds share one page. EarlyON Saturday at 10 a.m.'),
    ).toEqual({ text: 'EarlyON Saturday at 10 a.m.', cut: 1 });
  });
});

describe('augmentCoachSkillForFindPrivate', () => {
  it('returns the same skill when the turn is not a find', () => {
    expect(augmentCoachSkillForFindPrivate(BASE, null)).toBe(BASE);
  });

  it('appends the addendum only when one is passed', () => {
    const addendum: Skill = {
      meta: { name: 'coach-find-private', whenToUse: 'x', task: 'converse', tools: [] },
      instructions: 'keep the finding to yourself',
    };
    const next = augmentCoachSkillForFindPrivate(BASE, addendum);
    expect(next).not.toBe(BASE);
    expect(next.instructions).toBe('be terse\n\nkeep the finding to yourself');
    expect(next.meta).toBe(BASE.meta);
  });
});

describe('coach-find-private skill', () => {
  it('forbids result-set narration and gives no line to send', async () => {
    const skill = await loadCronSkill('coach-find-private');
    const prose = skill.instructions.replace(/\s+/g, ' ');
    expect(skill.meta.task).toBe('converse');
    expect(skill.meta.tools).toEqual([]);
    expect(prose).toContain('The parent sees only the finds');
    expect(prose).toContain('share a page');
    expect(prose).not.toContain('>');
    expect(prose).not.toMatch(/"[^"]{12,}"/);
  });

  it('leaves coach-nearby-find unchanged so coach eval recordings stay keyed', async () => {
    const nearby = await loadCronSkill('coach-nearby-find');
    expect(nearby.instructions).not.toContain('VIL-524');
    expect(nearby.instructions).not.toContain('Keep your thinking to yourself');
  });
});
