import {
  type RegisteredTool,
  type RunAgentResult,
  type RunAgentStreamingArgs,
  type Skill,
  runAgentStreaming,
} from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { buildChannelCoachTools } from '~/lib/channel/coach/tools';
import type { AgentContext, LoadAgentContextInput } from '~/lib/coach/context';
import type { TranscriptMessage } from '~/lib/coach/conversation';
import { searchVillageTool } from '~/lib/coach/tools';
import { loadCronSkill } from '~/lib/cron/skill';
import { VOICE_TOOL_ACK } from './copy';
import { VOICE_AGENT_NAME, type VoiceTurnPorts, voiceTurnStream } from './voice-turn';

const TICKET = {
  callSid: 'CA00000000000000000000000000000011',
  familyId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  parentUserId: '9c858901-8a57-4791-81fe-4c455b099bc9',
};
const CONVERSATION_ID = '2b1c6f10-9a4d-4c6b-9a9e-b0b7c0e2f111';
const NOW = new Date('2026-08-19T15:00:00.000Z');

const SKILL: Skill = {
  meta: { name: 'voice-turn', whenToUse: 'a call', task: 'speak', tools: ['lookup_week'] },
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
  truncatedRetries: 0,
  usage: {
    promptTokens: 900,
    completionTokens: 20,
    cacheReadTokens: 850,
    cacheCreationTokens: 0,
  },
};

const TOOLS = [{ name: 'lookup_week' }] as unknown as RegisteredTool[];

function build(overrides: Partial<VoiceTurnPorts> = {}) {
  const transcript: TranscriptMessage[] = [
    { role: 'user', content: 'thanks' },
    { role: 'assistant', content: 'anytime' },
  ];
  const loadContext = vi.fn(async (_input: LoadAgentContextInput) => CONTEXT);
  // The default fake STREAMS what it returns, because the real loop does: every text
  // block it ends up reporting as `answer` reached `onTextDelta` first. A fake that
  // returned an answer nobody heard was modelling a turn production cannot produce, and
  // it is what let a silent turn read as a completed one for as long as it did (VIL-295).
  const runStreaming = vi.fn(async (args: RunAgentStreamingArgs) => {
    if (RESULT.answer !== null) args.onTextDelta(RESULT.answer);
    return RESULT;
  });
  const recordRun = vi.fn(async () => {});
  const answerSpoken = vi.fn(async () => ({ status: 'not_an_answer' }) as const);
  const buildTools = vi.fn(() => TOOLS);
  const log = { error: vi.fn() };
  const ports: VoiceTurnPorts = {
    loadSkill: async () => SKILL,
    loadTranscript: async () => transcript,
    loadContext,
    answerSpoken,
    buildTools,
    client: () => ({ messages: {} }) as never,
    runStreaming,
    guardDeps: {} as never,
    recordRun,
    log,
    now: () => NOW,
    ...overrides,
  };
  return {
    turn: voiceTurnStream(ports),
    loadContext,
    runStreaming,
    recordRun,
    answerSpoken,
    buildTools,
    log,
    transcript,
  };
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

  it('runs with the SAME verbs a text turn gets, built for THIS call', async () => {
    const t = build();
    await t.turn.respond(input, vi.fn());

    const args = t.runStreaming.mock.calls[0]?.[0] as RunAgentStreamingArgs;
    expect(args.tools).toBe(TOOLS);
    expect(args.maxSteps).toBeGreaterThan(1);
    expect(args.skill.meta.task).toBe('speak');
    expect(args.toolContext).toEqual({
      familyId: TICKET.familyId,
      actor: TICKET.parentUserId,
    });
    expect(t.buildTools).toHaveBeenCalledWith(
      {
        familyId: TICKET.familyId,
        parentUserId: TICKET.parentUserId,
        conversationId: CONVERSATION_ID,
        now: NOW,
      },
      expect.any(Function),
    );
  });

  it('tells the skill it is on a CALL — the register depends on it', async () => {
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

  it('treats an answer the caller never heard as a failure too, not as a completed turn', async () => {
    // VIL-295. `answer` is what the loop COMPOSED; the question this branch is asking is
    // what the caller HEARD. They come apart on a content block with no words in it: the
    // stream fires no delta, so nothing reaches the speaker, and `answer` is a non-null
    // string all the same. The turn then returned normally — the caller got dead air on a
    // line they were holding, the session had nothing to apologise with because nothing
    // had thrown, and the run was filed as completed.
    const emitted: string[] = [];
    const t = build({
      runStreaming: vi.fn(async () => ({ ...RESULT, answer: '   ' })),
    });

    await expect(
      t.turn.respond(input, (token) => {
        emitted.push(token);
      }),
    ).rejects.toThrow(/no answer/);
    expect(emitted).toEqual([]);
    expect(t.recordRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('does not apologise for a turn the caller already heard the answer to', async () => {
    // The real shape, found by the eval: the model says the whole answer in the same
    // turn as its tool call, then has nothing left to add — so the loop's `answer` is
    // null while the caller has already been told everything.
    const emitted: string[] = [];
    const t = build({
      runStreaming: vi.fn(async (args: RunAgentStreamingArgs) => {
        args.onTextDelta("That's swim moved to Friday, pending your yes.");
        args.onToolCall?.({ name: 'propose_calendar_move' } as never);
        args.onTurnReset();
        return { ...RESULT, answer: null, steps: 2 };
      }),
    });

    await expect(t.turn.respond(input, (token) => emitted.push(token))).resolves.toBeUndefined();
    expect(emitted.join('')).toBe("That's swim moved to Friday, pending your yes.");
    expect(t.recordRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  /**
   * VIL-295. The apology is a claim about what happened, and it was wrong whenever the
   * words were already out of the speaker: the catch asked "did we draft?" when the
   * question that decides whether "I lost that one" is honest is "did the caller HEAR the
   * answer?". A recorder blip, a ledger write, anything after the last token, and a
   * caller who had just been told everything heard Hale apologise for it.
   */
  it('does not apologise when the model already spoke and the turn broke afterwards', async () => {
    const emitted: string[] = [];
    const t = build({
      runStreaming: vi.fn(async (args: RunAgentStreamingArgs) => {
        args.onTextDelta('Swim is Thursday at four thirty.');
        throw new Error('socket closed');
      }),
    });

    await expect(t.turn.respond(input, (token) => emitted.push(token))).resolves.toBeUndefined();
    expect(emitted.join('')).toBe('Swim is Thursday at four thirty.');
    expect(t.log.error).toHaveBeenCalled();
    // The words reached the caller, so the run is not a failure — the cost row has to say
    // the same thing the caller heard.
    expect(t.recordRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('still says the draft count when it spoke AND drafted before breaking', async () => {
    const emitted: string[] = [];
    const t = build({
      buildTools: vi.fn((_turn, onDraft) => {
        onDraft('act-1');
        return TOOLS;
      }),
      runStreaming: vi.fn(async (args: RunAgentStreamingArgs) => {
        args.onTextDelta('Right, one sec.');
        throw new Error('overloaded');
      }),
    });

    await t.turn.respond(input, (token) => emitted.push(token));

    expect(emitted.join('')).toContain('one change');
  });

  it('still fails when all the caller heard was the line covering the pause', async () => {
    const emitted: string[] = [];
    const t = build({
      runStreaming: vi.fn(async (args: RunAgentStreamingArgs) => {
        args.onToolCall?.({ name: 'lookup_week' } as never);
        args.onTurnReset();
        return { ...RESULT, answer: null, hitMaxSteps: true };
      }),
    });

    await expect(t.turn.respond(input, (token) => emitted.push(token))).rejects.toThrow(
      /no answer/,
    );
    expect(emitted.join('')).toBe(`${VOICE_TOOL_ACK} `);
    expect(t.recordRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });
});

describe('a spoken answer to something Hale asked', () => {
  it('is settled before the model, and the caller hears the receipt', async () => {
    const emitted: string[] = [];
    const t = build({
      answerSpoken: vi.fn(async () => ({
        status: 'answered' as const,
        spoken: 'Approved - add to your calendar.',
        handler: 'approval',
        outcome: 'approved',
      })),
    });

    await t.turn.respond({ ...input, prompt: 'yes' }, (token) => emitted.push(token));

    expect(emitted).toEqual(['Approved - add to your calendar.']);
    // No model, no cost, no agent run: nothing agentic happened on this turn.
    expect(t.runStreaming).not.toHaveBeenCalled();
    expect(t.recordRun).not.toHaveBeenCalled();
  });

  it('asks the answer stage about THIS call, with the words the caller actually said', async () => {
    const t = build();
    await t.turn.respond({ ...input, prompt: 'yeah go ahead' }, vi.fn());

    expect(t.answerSpoken).toHaveBeenCalledWith({
      familyId: TICKET.familyId,
      parentUserId: TICKET.parentUserId,
      conversationId: CONVERSATION_ID,
      utterance: 'yeah go ahead',
      now: NOW,
    });
  });
});

describe('the pause while a tool runs', () => {
  it('speaks a line BEFORE the tool when the model reached for one in silence', async () => {
    const emitted: string[] = [];
    const t = build({
      runStreaming: vi.fn(async (args: RunAgentStreamingArgs) => {
        args.onToolCall?.({ name: 'lookup_week' } as never);
        // The caller is already hearing something by the time the tool is invoked.
        expect(emitted).toEqual([`${VOICE_TOOL_ACK} `]);
        args.onTurnReset();
        args.onTextDelta('Swim is Thursday.');
        return RESULT;
      }),
    });

    await t.turn.respond(input, (token) => emitted.push(token));

    expect(emitted).toEqual([`${VOICE_TOOL_ACK} `, 'Swim is Thursday.']);
  });

  it('stays quiet when the model said its own line first — never both', async () => {
    const emitted: string[] = [];
    const t = build({
      runStreaming: vi.fn(async (args: RunAgentStreamingArgs) => {
        args.onTextDelta('Let me pull that up. ');
        args.onToolCall?.({ name: 'lookup_week' } as never);
        args.onTurnReset();
        args.onTextDelta('Swim is Thursday.');
        return RESULT;
      }),
    });

    await t.turn.respond(input, (token) => emitted.push(token));

    expect(emitted).toEqual(['Let me pull that up. ', 'Swim is Thursday.']);
    expect(emitted.join('')).not.toContain(VOICE_TOOL_ACK);
  });

  /**
   * VIL-295, the live one: "Let me pull up your week.You've got Noah's eighteen-month
   * well-baby visit" (founder call, 2026-08-20 05:02). Two SEPARATE utterances — the
   * preamble the model said before it reached for a tool, and the answer it streamed
   * after — arrive as one unbroken string because `onTurnReset` was a no-op. Twilio's TTS
   * reads "week.You've" as one word.
   *
   * The reset is exactly where the boundary belongs: it is the loop telling this consumer
   * that a turn ended. Voice cannot DROP the text the way a text surface does, so it must
   * separate it.
   */
  it('separates the preamble from the answer that follows it', async () => {
    const emitted: string[] = [];
    const t = build({
      runStreaming: vi.fn(async (args: RunAgentStreamingArgs) => {
        args.onTextDelta('Let me pull up your week.');
        args.onToolCall?.({ name: 'lookup_week' } as never);
        args.onTurnReset();
        args.onTextDelta("You've got the well-baby visit this week.");
        return RESULT;
      }),
    });

    await t.turn.respond(input, (token) => emitted.push(token));

    expect(emitted.join('')).toBe(
      "Let me pull up your week. You've got the well-baby visit this week.",
    );
  });

  it('adds no second space when the preamble already ended in one', async () => {
    const emitted: string[] = [];
    const t = build({
      runStreaming: vi.fn(async (args: RunAgentStreamingArgs) => {
        args.onTextDelta('Let me check. ');
        args.onToolCall?.({ name: 'lookup_week' } as never);
        args.onTurnReset();
        args.onTextDelta('Swim is Thursday.');
        return RESULT;
      }),
    });

    await t.turn.respond(input, (token) => emitted.push(token));

    expect(emitted.join('')).toBe('Let me check. Swim is Thursday.');
  });

  it('says nothing at all when the reset lands before a single word', async () => {
    const emitted: string[] = [];
    const t = build({
      runStreaming: vi.fn(async (args: RunAgentStreamingArgs) => {
        args.onTurnReset();
        args.onTextDelta('Swim is Thursday.');
        return RESULT;
      }),
    });

    await t.turn.respond(input, (token) => emitted.push(token));

    expect(emitted.join('')).toBe('Swim is Thursday.');
  });

  it('keeps what a tool turn already said out loud — a reset cannot un-speak it', async () => {
    const emitted: string[] = [];
    const t = build({
      runStreaming: vi.fn(async (args: RunAgentStreamingArgs) => {
        args.onTextDelta('Let me check your week. ');
        args.onToolCall?.({ name: 'lookup_week' } as never);
        args.onTurnReset();
        args.onTextDelta('Swim is Thursday.');
        return RESULT;
      }),
    });

    await t.turn.respond(input, (token) => emitted.push(token));

    expect(emitted).toEqual(['Let me check your week. ', 'Swim is Thursday.']);
  });
});

describe('a turn that broke after it had already changed something', () => {
  it('says the count out loud instead of "I lost that one"', async () => {
    const emitted: string[] = [];
    const t = build({
      buildTools: vi.fn((_turn, onDraft) => {
        onDraft('act-1');
        onDraft('act-2');
        return TOOLS;
      }),
      runStreaming: vi.fn(async () => {
        throw new Error('overloaded');
      }),
    });

    await t.turn.respond(input, (token) => emitted.push(token));

    expect(emitted.join('')).toContain('2 changes');
    expect(emitted.join('')).toMatch(/say yes/i);
    expect(t.recordRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(t.log.error).toHaveBeenCalled();
  });

  it('does the same when it runs out of steps mid-job', async () => {
    const emitted: string[] = [];
    const t = build({
      buildTools: vi.fn((_turn, onDraft) => {
        onDraft('act-1');
        return TOOLS;
      }),
      runStreaming: vi.fn(async () => ({ ...RESULT, answer: null, hitMaxSteps: true })),
    });

    await t.turn.respond(input, (token) => emitted.push(token));

    expect(emitted.join('')).toContain('one change');
  });
});

/**
 * THE REQUEST A SPOKEN TURN ACTUALLY PUTS ON THE WIRE.
 *
 * Everything above drives `voiceTurnStream` against a fake `runStreaming` port, which is
 * the right shape for testing what the turn DECIDES — and structurally incapable of
 * catching what broke voice v2 in production, because the defect was in the request the
 * real loop builds. So this block wires the REAL `runAgentStreaming`, the REAL coach tool
 * builder and the REAL voice-turn skill, and inspects the outbound `messages.stream`
 * arguments. Only the transport is a fake; nothing here simulates the model's reasoning
 * (rule #8).
 *
 * What it pins: a spoken turn must not ask the API to compile a sampling grammar.
 * `strict: true` is a per-credential, structure-keyed COLD cost — 16-83s measured across
 * the six coach schemas — paid before the first token and inside the window the SDK's
 * `timeout` guards. SMS absorbs it as a deferred retry that lands warm; a call has no
 * queue, so the caller hears 30s of nothing and then a fixed apology (#505 incident).
 */
describe('the wire a spoken turn builds', () => {
  /** A capturing transport: records the request, streams one text turn, no tool_use. */
  function capturingClient() {
    const stream = vi.fn((_params: { tools?: unknown }) => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Swim is Thursday.' },
        };
      },
      finalMessage: async () => ({
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        content: [{ type: 'text', text: 'Swim is Thursday.', citations: null }],
        usage: {
          input_tokens: 900,
          output_tokens: 12,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
        },
      }),
    }));
    return { client: { messages: { stream } } as never, stream };
  }

  /** Byte-for-byte the verbs relay-deps.ts registers for a call. */
  const coachTools = () =>
    buildChannelCoachTools({
      familyId: TICKET.familyId,
      reader: {} as never,
      draftPort: {} as never,
      activity: null,
      villageTool: searchVillageTool({} as never),
      onDraft: () => {},
      now: NOW,
    });

  /** The tool definitions the production voice path hands the API. */
  async function wireTools(): Promise<Array<Record<string, unknown>>> {
    const { client, stream } = capturingClient();
    const t = build({
      loadSkill: () => loadCronSkill('voice-turn'),
      buildTools: () => coachTools(),
      client: () => client,
      runStreaming: runAgentStreaming,
      guardDeps: {} as never,
    });

    await t.turn.respond(input, vi.fn());

    return (stream.mock.calls[0]?.[0].tools ?? []) as Array<Record<string, unknown>>;
  }

  it('sends every coach verb WITHOUT strict, so no turn waits on a grammar compile', async () => {
    const tools = await wireTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_framework_guidance',
      'lookup_week',
      'propose_calendar_add',
      'propose_calendar_cancel',
      'propose_calendar_move',
      'search_village',
    ]);
    expect(tools.filter((t) => 'strict' in t).map((t) => t.name)).toEqual([]);
  });

  it('POSITIVE CONTROL: those same schemas do compile a grammar when a run does not decline it', async () => {
    // Without this, the assertion above would pass just as happily against a build that
    // had dropped `strict` everywhere, or one that sent no tools at all.
    const { client, stream } = capturingClient();
    const skill = await loadCronSkill('voice-turn');

    await runAgentStreaming({
      skill,
      context: {},
      tools: coachTools(),
      client,
      maxSteps: 1,
      maxTokens: 240,
      toolContext: { familyId: TICKET.familyId, actor: TICKET.parentUserId },
      guardDeps: {} as never,
      onTextDelta: () => {},
      onTurnReset: () => {},
    });

    const tools = (stream.mock.calls[0]?.[0].tools ?? []) as Array<Record<string, unknown>>;
    expect(
      tools
        .filter((t) => t.strict === true)
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      'get_framework_guidance',
      'lookup_week',
      'propose_calendar_add',
      'propose_calendar_cancel',
      'propose_calendar_move',
      'search_village',
    ]);
  });

  it('still streams the answer it composed', async () => {
    const { client } = capturingClient();
    const emitted: string[] = [];
    const t = build({
      loadSkill: () => loadCronSkill('voice-turn'),
      buildTools: () => coachTools(),
      client: () => client,
      runStreaming: runAgentStreaming,
      guardDeps: {} as never,
    });

    await t.turn.respond(input, (token) => emitted.push(token));

    expect(emitted.join('')).toBe('Swim is Thursday.');
  });
});
