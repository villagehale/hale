import type { Skill } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import {
  GROUP_LEAVE_TOOL,
  askIsGrounded,
  augmentCoachSkillForGroupLeave,
  leaveGroupChatTool,
} from './group-leave-tool';

const SKILL: Skill = {
  meta: { name: 'coach-channel-sms', whenToUse: 'x', task: 'converse', tools: ['lookup_week'] },
  instructions: 'x',
};

describe('leave_group_chat (VIL-477)', () => {
  it('registers the quoted ask; holds no copy', async () => {
    const got: unknown[] = [];
    const tool = leaveGroupChatTool({
      memberWords: 'Hale please leave this chat, thanks',
      onLeave: (i) => got.push(i),
    });
    expect(tool.name).toBe(GROUP_LEAVE_TOOL);
    await tool.handler(
      {
        ask: '  Hale please leave this chat ',
        ifLeaveFails: 'I could not leave, still here.',
      } as never,
      {} as never,
    );
    expect(got).toEqual([
      { ask: 'Hale please leave this chat', ifLeaveFails: 'I could not leave, still here.' },
    ]);
  });

  it('refuses a blank ask back to the model, nothing registered', async () => {
    const got: unknown[] = [];
    const tool = leaveGroupChatTool({
      memberWords: 'Hale please leave this chat, thanks',
      onLeave: (i) => got.push(i),
    });
    await expect(tool.handler({ ask: '   ' } as never, {} as never)).rejects.toThrow(
      GROUP_LEAVE_TOOL,
    );
    expect(got).toEqual([]);
  });

  it('skill: dark is the same object; lit adds the verb once', () => {
    expect(augmentCoachSkillForGroupLeave(SKILL, false)).toBe(SKILL);
    const lit = augmentCoachSkillForGroupLeave(SKILL, true);
    expect(lit.meta.tools).toEqual(['lookup_week', GROUP_LEAVE_TOOL]);
    expect(augmentCoachSkillForGroupLeave(lit, true)).toBe(lit);
  });

  it('too_small: nothing registered; result says Hale is staying in the chat and why', async () => {
    const got: unknown[] = [];
    const tool = leaveGroupChatTool({
      memberWords: 'Hale please leave this chat, thanks',
      onLeave: (i) => got.push(i),
      check: async () => ({ ok: false, reason: 'too_small' }),
    });
    const out = (await tool.handler(
      { ask: 'Hale please leave', ifLeaveFails: 'x' } as never,
      {} as never,
    )) as Record<string, unknown>;
    expect(got).toEqual([]);
    expect(out).toMatchObject({ left: false, stillInChat: true, reason: 'too_small' });
    expect(String(out.why)).toMatch(/too small/);
    expect(String(out.note)).toMatch(/did NOT leave/);
  });

  it('eligible: registers and says the leave happens after the reply', async () => {
    const got: unknown[] = [];
    const tool = leaveGroupChatTool({
      memberWords: 'Hale please leave this chat, thanks',
      onLeave: (i) => got.push(i),
      check: async () => ({ ok: true }),
    });
    const out = await tool.handler(
      { ask: '"hale, please leave"', ifLeaveFails: 'Model line.' } as never,
      {} as never,
    );
    expect(got).toEqual([{ ask: '"hale, please leave"', ifLeaveFails: 'Model line.' }]);
    expect(out).toMatchObject({ registered: true, willLeaveAfterReply: true });
  });

  it("ungrounded: an ask not in this turn's member words registers nothing", async () => {
    const got: unknown[] = [];
    const tool = leaveGroupChatTool({
      memberWords: 'can someone grab milk on the way home',
      onLeave: (i) => got.push(i),
      check: async () => ({ ok: true }),
    });
    const out = (await tool.handler(
      { ask: 'Hale please leave this group', ifLeaveFails: 'x' } as never,
      {} as never,
    )) as Record<string, unknown>;
    expect(got).toEqual([]);
    expect(out).toMatchObject({ left: false, stillInChat: true, reason: 'not_asked_this_turn' });
  });

  it('grounded needs whole words, not a fragment', () => {
    expect(askIsGrounded('Leave', 'Hale, please LEAVE!')).toBe(true);
    expect(askIsGrounded('leave', 'we are leaving soon')).toBe(false);
    expect(askIsGrounded('', 'leave')).toBe(false);
  });

  it('refuses a missing ifLeaveFails line back to the model, nothing registered', async () => {
    const got: unknown[] = [];
    const tool = leaveGroupChatTool({
      memberWords: 'Hale please leave',
      onLeave: (i) => got.push(i),
      check: async () => ({ ok: true }),
    });
    await expect(
      tool.handler({ ask: 'Hale please leave', ifLeaveFails: ' ' } as never, {} as never),
    ).rejects.toThrow(/ifLeaveFails/);
    expect(got).toEqual([]);
  });
});
