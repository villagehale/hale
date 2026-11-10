import type { Skill } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCronSkill, loadOnboardingFriendSkill } from '~/lib/cron/skill';
import {
  AGE_FIT_CORRECTION_ENABLED_ENV,
  ageFitCorrectionEnabled,
  appendAgeFitCorrectionSkill,
} from './age-fit-correction';
import { friendVoiceSystem } from './friend-voice';

const BASE: Skill = {
  meta: { name: 'coach-channel-sms', whenToUse: 'x', task: 'converse', tools: [] },
  instructions: 'be terse',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AGE_FIT_CORRECTION_ENABLED', () => {
  it('is on only for the exact string true', () => {
    vi.stubEnv(AGE_FIT_CORRECTION_ENABLED_ENV, 'true');
    expect(ageFitCorrectionEnabled()).toBe(true);
  });

  it.each(['', 'true\n', 'TRUE', 'True', 'on', '1', 'yes', ' false', 'true '])(
    'stays off for %j',
    (value) => {
      vi.stubEnv(AGE_FIT_CORRECTION_ENABLED_ENV, value);
      expect(ageFitCorrectionEnabled()).toBe(false);
    },
  );

  it('stays off when the variable is unset', () => {
    vi.stubEnv(AGE_FIT_CORRECTION_ENABLED_ENV, undefined);
    expect(ageFitCorrectionEnabled()).toBe(false);
    expect(ageFitCorrectionEnabled({})).toBe(false);
  });
});

describe('appendAgeFitCorrectionSkill', () => {
  it('returns the same skill when the addendum is off', () => {
    expect(appendAgeFitCorrectionSkill(BASE, null)).toBe(BASE);
  });

  it('appends the addendum only when one is passed', () => {
    const addendum: Skill = {
      meta: { name: 'age-fit-correction', whenToUse: 'x', task: 'converse', tools: [] },
      instructions: 'take the correction',
    };
    const next = appendAgeFitCorrectionSkill(BASE, addendum);
    expect(next).not.toBe(BASE);
    expect(next.instructions).toBe('be terse\n\ntake the correction');
    expect(next.meta).toBe(BASE.meta);
  });
});

describe('age-fit-correction skill', () => {
  it('directs the model and gives no line to send', async () => {
    const skill = await loadCronSkill('age-fit-correction');
    const prose = skill.instructions.replace(/\s+/g, ' ');
    expect(skill.meta.task).toBe('converse');
    expect(skill.meta.tools).toEqual([]);
    expect(prose).toMatch(/does not fit/i);
    expect(prose).toMatch(/agree/i);
    expect(prose).toMatch(/do not keep offering/i);
    expect(prose).toMatch(/\btu\b/);
    expect(prose).not.toContain('>');
    expect(prose).not.toMatch(/"[^"]{12,}"/);
  });

  it('leaves the disk coach and onboarding-friend bytes unchanged', async () => {
    const coach = await loadCronSkill('coach-channel-sms');
    const friend = await loadOnboardingFriendSkill();
    for (const skill of [coach, friend]) {
      expect(skill.instructions).not.toContain('age-fit-correction');
      expect(skill.instructions).not.toMatch(/Do not keep offering that program/);
    }
  });
});

describe('friendVoiceSystem age-fit addendum', () => {
  it('keeps onboarding-friend bytes when the flag is off', async () => {
    vi.stubEnv(AGE_FIT_CORRECTION_ENABLED_ENV, '');
    vi.stubEnv('FRIEND_VOICE_LEFTOVER_MARKS_ENABLED', '');
    const base = (await loadOnboardingFriendSkill()).instructions;
    expect((await friendVoiceSystem({ step: 'ack' }, false)).system).toBe(base);
  });

  it('appends the addendum when the flag is on, including the retry prompt', async () => {
    vi.stubEnv('FRIEND_VOICE_LEFTOVER_MARKS_ENABLED', '');
    vi.stubEnv(AGE_FIT_CORRECTION_ENABLED_ENV, 'true');
    const addendum = (await loadCronSkill('age-fit-correction')).instructions;
    const full = (await loadOnboardingFriendSkill()).instructions;
    expect((await friendVoiceSystem({ step: 'ack' }, false)).system).toBe(`${full}\n\n${addendum}`);
    const short = (await loadCronSkill('onboarding-friend-short')).instructions;
    expect((await friendVoiceSystem({ step: 'schedule' }, true)).system).toBe(
      `${short}\n\n${addendum}`,
    );
  });
});
