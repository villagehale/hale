import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { composeAutonomyNotice } from './compose';
import type { AutonomyNoticeContext } from './notice-text';

vi.mock('~/lib/cron/skill', () => ({
  loadCronSkill: vi.fn(async () => {
    throw new Error('skill file missing');
  }),
}));

describe('composeAutonomyNotice', () => {
  it('a skill that will not load is a named skip, so the text stays owed and ops can hear', async () => {
    await expect(
      composeAutonomyNotice({} as AutonomyNoticeContext, {} as AgentClient),
    ).resolves.toEqual({ skipped: 'skill_unavailable' });
  });
});
