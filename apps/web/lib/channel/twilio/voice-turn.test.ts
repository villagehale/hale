import type { RunAgentResult, RunAgentStreamingArgs, Skill } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import type { AgentContext, LoadAgentContextInput } from '~/lib/coach/context';
import type { TranscriptMessage } from '~/lib/coach/conversation';
import { VOICE_AGENT_NAME, type VoiceTurnPorts, voiceTurnStream } from './voice-turn';

const TICKET = {
  callSid: 'CA00000000000000000000000000000011',
  familyId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  parentUserId: '9c858901-8a57-4791-81fe-4c455b099bc9',
};
const CONVERSATION_ID = '2b1c6f10-9a4d-4c6b-9a9e-b0b7c0e2f111';
const NOW = new Date('2026-08-19T15:00:00.000Z');

const SKILL: Skill = {
  meta: { name: 'voice-turn', whenToUse: 'a call', task: 'speak', tools: [] },
  instructions: 'speak briefly',
};

const CONTEXT = {
  parentName: 'Sam',
  planTier: 'free',
  children: [],
  transcript: [],
  question: '',
} as unknown as AgentContext;

const RESULT: RunAgentResult = {
  answer: 'Swim is Thursday at four thirty.',
  steps: 1,
  hitMaxSteps: false,
  usage: {
    promptTokens: 900,
    completionTokens: 20,
    cacheReadTokens: 850,
    cacheCreationTokens: 0,
  },
};

function build(overrides: Partial<VoiceTurnPorts> = {}) {
  const transcript: TranscriptMessage[] = [
    { role: 'user', content: 'thanks' },
    { role: 'assistant', content: 'anytime' },
  ];
  const loadContext = vi.fn(async (_input: LoadAgentContextInput) => CONTEXT);
  const runStreaming = vi.fn(async (_args: RunAgentStreamingArgs) => RESULT);
  const recordRun = vi.fn(async () => {});
  const ports: VoiceTurnPorts = {
    loadSkill: async () => SKILL,
    loadTranscript: async () => transcript,
    loadContext,
    client: () => ({ messages: {} }) as never,
    runStreaming,
    guardDeps: {} as never,
    recordRun,
    now: () => NOW,
    ...overrides,
  };
  return { turn: voiceTurnStream(ports), loadContext, runStreaming, recordRun, transcript };
}

const input = { prompt: 'when is swim', ticket: TICKET, conversationId: CONVERSATION_ID };

describe('voiceTurnStream', () => {
  it('reads the SAME thread the SMS coach reads, and asks the question the caller asked', async () => {
    const t = build();
    await t.turn.respond(input, vi.fn());

    expect(t.loadContext).toHaveBeenCalledWith({
      familyId: TICKET.familyId,
      question: 'when is swim',
      intent: null,
      focusedChildId: null,
      transcript: t.transcript,
      sourceNote: null,
    });
  });

  it('forwards every token as it arrives rather than after the answer is finished', async () => {
    const emitted: string[] = [];
    const t = build({
      runStreaming: vi.fn(async (args: RunAgentStreamingArgs) => {
        args.onTextDelta('Swim is ');
        expect(emitted).toEqual(['Swim is ']);
        args.onTextDelta('Thursday.');
        return RESULT;
      }),
    });

    await t.turn.respond(input, (token) => emitted.push(token));

    expect(emitted).toEqual(['Swim is ', 'Thursday.']);
  });

  it('runs with NO tools and one step — nothing can be done from a call', async () => {
    const t = build();
    await t.turn.respond(input, vi.fn());

    const args = t.runStreaming.mock.calls[0]?.[0] as RunAgentStreamingArgs;
    expect(args.tools).toEqual([]);
    expect(args.maxSteps).toBe(1);
    expect(args.skill.meta.task).toBe('speak');
    expect(args.toolContext).toEqual({
      familyId: TICKET.familyId,
      actor: TICKET.parentUserId,
    });
  });

  it("tells the skill it is on a CALL — the register depends on it", async () => {
    const t = build();
    await t.turn.respond(input, vi.fn());

    const args = t.runStreaming.mock.calls[0]?.[0] as RunAgentStreamingArgs;
    expect(args.context).toMatchObject({ channel: 'voice', nowIso: NOW.toISOString() });
  });

  it('records the run so a call has a cost, and marks it completed', async () => {
    const t = build();
    await t.turn.respond(input, vi.fn());

    expect(t.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: TICKET.familyId,
        agentName: VOICE_AGENT_NAME,
        status: 'completed',
        promptTokens: 900,
        completionTokens: 20,
        promptCacheHit: true,
      }),
    );
  });

  it('records the FAILED run too, then re-throws so the session speaks its fixed line', async () => {
    const t = build({
      runStreaming: vi.fn(async () => {
        throw new Error('overloaded');
      }),
    });

    await expect(t.turn.respond(input, vi.fn())).rejects.toThrow('overloaded');
    expect(t.recordRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('treats a turn that produced no words as a failure, not as silence', async () => {
    const t = build({
      runStreaming: vi.fn(async () => ({ ...RESULT, answer: null })),
    });

    await expect(t.turn.respond(input, vi.fn())).rejects.toThrow(/no answer/);
    expect(t.recordRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

});
