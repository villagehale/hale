import type { Skill } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { loadCronSkill } from '~/lib/cron/skill';
import {
  augmentCoachSkillForFindPrivate,
  createFindTurnReader,
  findTurnUserMessage,
  toFindTurnReading,
} from './find-private';

const BASE: Skill = {
  meta: { name: 'coach-channel-sms', whenToUse: 'x', task: 'converse', tools: [] },
  instructions: 'be terse',
};

describe('toFindTurnReading', () => {
  it('is a find only when the model named find', () => {
    expect(toFindTurnReading({ intent: 'find' })).toEqual({ findTurn: true });
    expect(toFindTurnReading({ intent: 'not_find' })).toEqual({
      findTurn: false,
      reason: 'not_find',
    });
  });

  it('names an intent off the enum and logs it, apart from a not_find', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(toFindTurnReading({ intent: 'unclear' })).toEqual({
      findTurn: false,
      reason: 'off_enum_intent',
    });
    expect(JSON.stringify(warned.mock.calls)).toContain('off_enum_intent');
    warned.mockRestore();
  });
});

describe('findTurnUserMessage', () => {
  it('shows the model the earlier user turns, not only this text', () => {
    const payload = JSON.parse(
      findTurnUserMessage('the library one', [
        { role: 'user', content: "what's on this weekend" },
        { role: 'assistant', content: 'Storytime is on.' },
      ]),
    ) as { text: string; prior: string[] };
    expect(payload.text).toBe('the library one');
    expect(payload.prior).toEqual(["what's on this weekend"]);
  });

  it('does not duplicate this text when the transcript already ends with it', () => {
    const body = 'move swim to tuesday';
    const payload = JSON.parse(findTurnUserMessage(body, [{ role: 'user', content: body }])) as {
      text: string;
      prior: string[];
    };
    expect(payload.text).toBe(body);
    expect(payload.prior).toEqual([]);
  });
});

describe('createFindTurnReader', () => {
  it('names a missing client as a failed read, warns, and leaves out the parent text', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reader = createFindTurnReader(() => {
      throw new Error('no key');
    });
    await expect(reader.read({ text: "what's on this weekend", transcript: [] })).resolves.toEqual({
      findTurn: false,
      reason: 'client_unavailable',
    });
    expect(JSON.stringify(warned.mock.calls)).toContain('client_unavailable');
    expect(JSON.stringify(warned.mock.calls)).not.toContain("what's on this weekend");
    warned.mockRestore();
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

describe('coach-find-turn skill', () => {
  it('reads intent in any language and gives no line to send', async () => {
    const skill = await loadCronSkill('coach-find-turn');
    const prose = skill.instructions.replace(/\s+/g, ' ');
    expect(skill.meta.task).toBe('screen');
    expect(skill.meta.tools).toEqual([]);
    expect(prose).toContain('any language');
    expect(prose).not.toContain('>');
    expect(prose).not.toMatch(/"[^"]{12,}"/);
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

describe('coach-find-day skill', () => {
  it('reads the day from the thread and leads with what runs that day, with no line to send', async () => {
    const skill = await loadCronSkill('coach-find-day');
    const prose = skill.instructions.replace(/\s+/g, ' ');
    expect(skill.meta.task).toBe('converse');
    expect(skill.meta.tools).toEqual([]);
    expect(prose).toContain('localNow');
    expect(prose).toContain('window');
    expect(prose).toContain('earlier in the thread');
    expect(prose).not.toContain('>');
    expect(prose).not.toMatch(/"[^"]{12,}"/);
  });
});
