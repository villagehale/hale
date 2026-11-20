import { type Skill, invokeTool } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import {
  REACT_TOOL,
  type ReactionChoice,
  augmentCoachSkillForReactions,
  isOtherToolCall,
  reactToParentMessageTool,
} from './reaction-tool';

const CTX = { familyId: 'f', actor: 'p' };
const GUARD = { async writeAudit() {} };

function verb() {
  const chosen: ReactionChoice[] = [];
  const tool = reactToParentMessageTool({ onReact: (choice) => chosen.push(choice) });
  return { tool, chosen };
}

describe('react_to_parent_message', () => {
  it('only registers the choice: it sends nothing and the loop may end on it', () => {
    const { tool } = verb();
    expect(tool.name).toBe(REACT_TOOL);
    expect(tool.registersOnly).toBe(true);
    expect(tool.monetary).toBe(false);
    expect(tool.touchesChildContent).toBe(false);
  });

  it('records a standard tapback or one emoji, and whether it stands alone', async () => {
    const { tool, chosen } = verb();
    await invokeTool(tool, { reaction: 'love', alone: true }, CTX, GUARD);
    await invokeTool(tool, { reaction: '🎉', alone: false }, CTX, GUARD);
    expect(chosen).toEqual([
      { reaction: { type: 'love' }, alone: true },
      { reaction: { type: 'custom', emoji: '🎉' }, alone: false },
    ]);
  });

  it.each(['🎉🎉', 'thumbs up', 'LOVE', ''])(
    'refuses %j back to the model and records nothing',
    async (reaction) => {
      const { tool, chosen } = verb();
      await expect(invokeTool(tool, { reaction, alone: true }, CTX, GUARD)).rejects.toThrow();
      expect(chosen).toEqual([]);
    },
  );
});

describe('augmentCoachSkillForReactions', () => {
  const skill: Skill = {
    meta: { name: 'coach-channel-sms', whenToUse: 'x', task: 'converse', tools: ['lookup_week'] },
    instructions: 'be terse',
  };
  const addendum: Skill = {
    meta: { name: 'coach-reaction', whenToUse: 'x', task: 'converse', tools: [] },
    instructions: 'react like a friend',
  };

  it('dark: the very same skill object, so the prompt bytes do not move', () => {
    expect(augmentCoachSkillForReactions(skill, null)).toBe(skill);
  });

  it('lit: lists the verb and appends the addendum', () => {
    const lit = augmentCoachSkillForReactions(skill, addendum);
    expect(lit.meta.tools).toEqual(['lookup_week', REACT_TOOL]);
    expect(lit.instructions).toBe('be terse\n\nreact like a friend');
  });
});

describe('isOtherToolCall', () => {
  it('counts every audited call except the reaction verb itself', () => {
    expect(isOtherToolCall(`tool:${REACT_TOOL}`)).toBe(false);
    expect(isOtherToolCall('tool:stop_watching')).toBe(true);
    expect(isOtherToolCall('tool_refused')).toBe(true);
  });
});
