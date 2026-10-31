import type { Skill } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { loadCronSkill } from '~/lib/cron/skill';
import { augmentCoachSkillForFindPrivate, nearbyFindTurn } from './find-private';

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
