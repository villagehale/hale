import { describe, expect, it } from 'vitest';
import { SONNET_MODEL, pickLane } from './model.js';
import { loadSkill } from './skill.js';

describe('reminder writer tier', () => {
  it('runs on Sonnet 5.5 with thinking off, like said-line (#919)', async () => {
    const skill = await loadSkill('reminder');
    const lane = pickLane(skill.meta.task);
    expect(lane.model).toBe(SONNET_MODEL);
    expect(SONNET_MODEL).toBe('claude-sonnet-5-5');
    expect(lane.thinking).toBe('between_tools');
  });
});
