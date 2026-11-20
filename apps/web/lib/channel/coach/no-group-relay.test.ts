import type { Skill } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCronSkill } from '~/lib/cron/skill';
import {
  GROUP_1TO1_NO_GROUP_RELAY_ENABLED_ENV,
  appendNoGroupRelaySkill,
  group1to1NoGroupRelayEnabled,
} from './no-group-relay';

const BASE: Skill = {
  meta: { name: 'coach-channel-sms', whenToUse: 'x', task: 'converse', tools: [] },
  instructions: 'be terse',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GROUP_1TO1_NO_GROUP_RELAY_ENABLED', () => {
  it('is on only for the exact string true', () => {
    vi.stubEnv(GROUP_1TO1_NO_GROUP_RELAY_ENABLED_ENV, 'true');
    expect(group1to1NoGroupRelayEnabled()).toBe(true);
  });

  it.each(['', 'true\n', 'TRUE', 'True', 'on', '1', 'yes', ' false', 'true '])(
    'stays off for %j',
    (value) => {
      vi.stubEnv(GROUP_1TO1_NO_GROUP_RELAY_ENABLED_ENV, value);
      expect(group1to1NoGroupRelayEnabled()).toBe(false);
    },
  );

  it('stays off when the variable is unset', () => {
    vi.stubEnv(GROUP_1TO1_NO_GROUP_RELAY_ENABLED_ENV, undefined);
    expect(group1to1NoGroupRelayEnabled()).toBe(false);
    expect(group1to1NoGroupRelayEnabled({})).toBe(false);
  });
});

describe('appendNoGroupRelaySkill', () => {
  it('returns the same skill when the addendum is off', () => {
    expect(appendNoGroupRelaySkill(BASE, null)).toBe(BASE);
  });

  it('appends the addendum only when one is passed', () => {
    const addendum: Skill = {
      meta: { name: 'coach-no-group-relay', whenToUse: 'x', task: 'converse', tools: [] },
      instructions: 'do not promise a group post',
    };
    const next = appendNoGroupRelaySkill(BASE, addendum);
    expect(next).not.toBe(BASE);
    expect(next.instructions).toBe('be terse\n\ndo not promise a group post');
    expect(next.meta).toBe(BASE.meta);
  });
});

describe('coach-no-group-relay skill', () => {
  it('directs the model and gives no line to send', async () => {
    const skill = await loadCronSkill('coach-no-group-relay');
    const prose = skill.instructions.replace(/\s+/g, ' ');
    expect(skill.meta.task).toBe('converse');
    expect(skill.meta.tools).toEqual([]);
    expect(prose).toMatch(/cannot post/i);
    expect(prose).toMatch(/never offer/i);
    expect(prose).toMatch(/tell the group themselves/i);
    expect(prose).toMatch(/do not promise/i);
    expect(prose).toMatch(/\btu\b/);
    expect(prose).not.toContain('>');
    expect(prose).not.toMatch(/"[^"]{12,}"/);
  });

  it('leaves the disk coach bytes unchanged', async () => {
    const coach = await loadCronSkill('coach-channel-sms');
    expect(coach.instructions).not.toContain('coach-no-group-relay');
    expect(coach.instructions).not.toMatch(/cannot post to a group chat from this 1:1/);
  });
});

describe('group-private-aside-draft (VIL-577, already on main)', () => {
  it('still forbids offering to tell the group for a family', async () => {
    const skill = await loadCronSkill('group-private-aside-draft');
    const prose = skill.instructions.replace(/\s+/g, ' ');
    expect(prose).toMatch(/never offer to tell, say or pass on anything to the group for them/);
    expect(prose).toMatch(/They tell the group themselves/);
    expect(prose).not.toContain('let them choose what to tell the group');
  });
});
