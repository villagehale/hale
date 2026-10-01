import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { DraftedAction, ToolResult } from '@hale/types';
import { REQUIRED_CHECKS, REVIEWER_TOOLS, type ReviewerToolName } from '@hale/tools-contracts';
import { runReviewer, type ReviewerAnthropicClient } from './reviewer.js';

/**
 * These tests script the Anthropic SDK transport (messages.create), NOT the
 * LLM's semantics — control-flow testing of the hand-rolled tool-use loop.
 * (Agent-behavior evals are B12 and use the real cached-LLM harness; hard
 * rule #8 applies there, not here.)
 */

const VERDICT_TOOL = 'submit_verdict';

function draft(actionType: DraftedAction['actionType']): DraftedAction {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    eventId: '33333333-3333-4333-8333-333333333333',
    familyId: '11111111-1111-4111-8111-111111111111',
    actionType,
    payload: { to: 'clinic@example.com', subject: 'hi', body: 'hello' },
    draftConfidence: 0.9,
    rationale: 'drafted',
    recipientVisibility: 'public',
    draftedAt: '2026-06-12T10:00:00.000Z',
  };
}

/** A turn the model emits: a list of tool_use blocks (verdict or a check). */
type ScriptedTurn = Array<{ name: string; input: unknown }>;

function assistantMessage(blocks: ScriptedTurn): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
    },
    content: blocks.map((b, i) => ({
      type: 'tool_use' as const,
      id: `tu_${i}`,
      name: b.name,
      input: b.input as Record<string, unknown>,
    })),
  };
}

/**
 * Builds a mock client whose messages.create returns the scripted turns in
 * order. The reviewer drives the loop; each call pops the next turn.
 */
function scriptedClient(turns: ScriptedTurn[]): ReviewerAnthropicClient {
  let call = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        const turn = turns[call] ?? [];
        call += 1;
        return assistantMessage(turn);
      }),
    },
  } as unknown as ReviewerAnthropicClient;
}

const familyId = '11111111-1111-4111-8111-111111111111';

/** Fake tool executor: every requested check returns ok, no DB. */
function okExecutor(): (name: ReviewerToolName, input: unknown) => Promise<ToolResult> {
  return vi.fn(async (name) => ({ tool: name, ok: true, result: { ok: true } }));
}

/** Fake child-name lookup so check_pii_leak enrichment never hits the DB. */
const noChildNames = async () => [] as string[];

/** Turn that calls every required check for an action, one tool_use block each. */
function callAllRequired(actionType: DraftedAction['actionType']): ScriptedTurn {
  return REQUIRED_CHECKS[actionType].map((name) => ({ name, input: { familyId } }));
}

describe('runReviewer — hard rule #3 coverage guard', () => {
  it('DOWNGRADES approve-with-zero-tool-calls to flag_for_human', async () => {
    // Model jumps straight to a verdict without invoking ANY verification tool.
    const client = scriptedClient([
      [{ name: VERDICT_TOOL, input: { verdict: 'approve', rationale: 'looks fine' } }],
    ]);

    const { verdict } = await runReviewer({ familyId, draft: draft('send_email') }, { client });

    expect(verdict.kind).toBe('flag_for_human');
    expect(verdict.rationale).toContain('COVERAGE_NOT_SATISFIED');
  });

  it('APPROVES when every required check was invoked', async () => {
    const client = scriptedClient([
      callAllRequired('send_email'),
      [{ name: VERDICT_TOOL, input: { verdict: 'approve', rationale: 'all checks green' } }],
    ]);

    const { verdict } = await runReviewer(
      { familyId, draft: draft('send_email') },
      { client, invokeTool: okExecutor(), loadChildNames: noChildNames },
    );

    expect(verdict.kind).toBe('approve');
    expect(verdict.toolResults.map((r) => r.tool).sort()).toEqual(
      [...REQUIRED_CHECKS.send_email].sort(),
    );
  });

  it('DOWNGRADES approve when one required check is missing', async () => {
    // send_email requires [pii_leak, recipient_allowlist, idempotency]; omit one.
    const partial = REQUIRED_CHECKS.send_email.slice(1).map((name) => ({
      name,
      input: { familyId },
    }));
    const client = scriptedClient([
      partial,
      [{ name: VERDICT_TOOL, input: { verdict: 'approve', rationale: 'mostly fine' } }],
    ]);

    const { verdict } = await runReviewer(
      { familyId, draft: draft('send_email') },
      { client, invokeTool: okExecutor() },
    );

    expect(verdict.kind).toBe('flag_for_human');
    expect(verdict.rationale).toContain('COVERAGE_NOT_SATISFIED');
  });

  it('continues the loop when a tool execution errors, then flags for human', async () => {
    const failing = vi.fn(async (name: ReviewerToolName) => ({
      tool: name,
      ok: false,
      result: { error: 'boom' },
    }));
    const client = scriptedClient([
      [{ name: 'check_pii_leak', input: { familyId } }],
      [{ name: VERDICT_TOOL, input: { verdict: 'approve', rationale: 'ignoring the error' } }],
    ]);

    const { verdict } = await runReviewer(
      { familyId, draft: draft('send_email') },
      { client, invokeTool: failing, loadChildNames: noChildNames },
    );

    // Tool ran (loop continued past the error) but coverage is incomplete → downgrade.
    expect(failing).toHaveBeenCalledTimes(1);
    expect(verdict.kind).toBe('flag_for_human');
    expect(verdict.toolResults).toHaveLength(1);
  });

  it('flags for human when the turn cap is exhausted without a verdict', async () => {
    // Every turn the model only calls a check, never submit_verdict → cap hit.
    const turns: ScriptedTurn[] = Array.from({ length: 12 }, () => [
      { name: 'check_action_idempotency', input: { familyId } },
    ]);
    const client = scriptedClient(turns);

    const { verdict } = await runReviewer(
      { familyId, draft: draft('send_email') },
      { client, invokeTool: okExecutor() },
    );

    expect(verdict.kind).toBe('flag_for_human');
    expect(verdict.rationale).toContain('turn cap');
    expect((client.messages.create as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(8);
  });

  it('DOWNGRADES approve when every required check ran but one returned ok:false (cap exceeded)', async () => {
    // place_supply_order requires check_spending_cap; the cap check comes back
    // failing (hard rule #7: cap exceeded → reject). Full NAME coverage, but the
    // result is red → must not be approvable.
    const capExceeded = vi.fn(async (name: ReviewerToolName) => ({
      tool: name,
      ok: name !== 'check_spending_cap',
      result: name === 'check_spending_cap' ? { exceededCap: 'per_action' } : { ok: true },
    }));
    const client = scriptedClient([
      callAllRequired('place_supply_order'),
      [{ name: VERDICT_TOOL, input: { verdict: 'approve', rationale: 'shipping it anyway' } }],
    ]);

    const { verdict } = await runReviewer(
      { familyId, draft: draft('place_supply_order') },
      { client, invokeTool: capExceeded },
    );

    expect(verdict.kind).toBe('flag_for_human');
    expect(verdict.rationale).toContain('check_spending_cap');
  });

  it('marks the reviewer system prefix cacheable, with the draft outside it', async () => {
    const create = vi.fn(
      async (_req: Anthropic.MessageCreateParamsNonStreaming) => assistantMessage([]),
    );
    const client = { messages: { create } } as unknown as ReviewerAnthropicClient;

    await runReviewer({ familyId, draft: draft('send_email') }, { client });

    const req = create.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    const systemBlocks = req.system as Anthropic.TextBlockParam[];
    expect(systemBlocks).toHaveLength(1);
    expect(systemBlocks[0]?.cache_control).toEqual({ type: 'ephemeral' });
    // The variable per-review draft (identified by its draft id) rides in
    // messages, outside the cached prefix.
    const draftId = draft('send_email').id;
    expect(JSON.stringify(req.system)).not.toContain(draftId);
    expect(JSON.stringify(req.messages)).toContain(draftId);
  });

  it('passes a reject verdict through unchanged', async () => {
    const client = scriptedClient([
      [
        {
          name: VERDICT_TOOL,
          input: { verdict: 'reject', rationale: 'PII leak', remediation: 'redact SIN' },
        },
      ],
    ]);

    const { verdict } = await runReviewer({ familyId, draft: draft('send_email') }, { client });

    expect(verdict.kind).toBe('reject');
    if (verdict.kind === 'reject') {
      expect(verdict.remediation).toBe('redact SIN');
    }
  });
});

describe('runReviewer — calendar_conflict args are injected server-side (rule #3)', () => {
  function calendarDraft(): DraftedAction {
    return {
      id: '44444444-4444-4444-8444-444444444444',
      eventId: '55555555-5555-4555-8555-555555555555',
      familyId,
      actionType: 'calendar_add',
      payload: {
        title: 'Swim class',
        startsAt: '2026-07-10T14:00:00.000Z',
        endsAt: '2026-07-10T14:45:00.000Z',
        action_hash: 'deadbeef',
      },
      draftConfidence: 0.9,
      rationale: 'placement',
      recipientVisibility: 'internal_only',
      draftedAt: '2026-07-06T10:00:00.000Z',
    };
  }

  it('overrides the model args with the real family + window (duration derived from the payload)', async () => {
    // The model calls the conflict check with garbage/empty args; the reviewer must
    // replace them with the family id and the REAL window from the draft payload.
    const client = scriptedClient([
      [
        { name: 'check_action_time_window', input: { familyId } },
        { name: 'check_action_idempotency', input: { familyId } },
        { name: 'check_calendar_conflict', input: { familyId: 'SPOOFED', startsAt: 'whenever', durationMinutes: 1 } },
      ],
      [{ name: VERDICT_TOOL, input: { verdict: 'approve', rationale: 'slot clear' } }],
    ]);

    const seen: Array<{ name: string; input: unknown }> = [];
    const capturing = vi.fn(async (name: ReviewerToolName, input: unknown) => {
      seen.push({ name, input });
      return { tool: name, ok: true, result: { hasConflict: false } };
    });

    const { verdict } = await runReviewer(
      { familyId, draft: calendarDraft() },
      { client, invokeTool: capturing, loadChildNames: noChildNames },
    );

    expect(verdict.kind).toBe('approve');
    const conflictCall = seen.find((c) => c.name === 'check_calendar_conflict');
    expect(conflictCall?.input).toEqual({
      familyId,
      startsAt: '2026-07-10T14:00:00.000Z',
      durationMinutes: 45,
    });
  });
})

describe('runReviewer — time_window args are injected server-side (rule #3)', () => {
  function timeWindowDraft(
    actionType: DraftedAction['actionType'],
    payload: Record<string, unknown>,
    draftedAt = '2026-07-06T10:00:00.000Z',
  ): DraftedAction {
    return {
      id: '66666666-6666-4666-8666-666666666666',
      eventId: '77777777-7777-4777-8777-777777777777',
      familyId,
      actionType,
      payload: { ...payload, action_hash: 'deadbeef' },
      draftConfidence: 0.9,
      rationale: 'placement',
      recipientVisibility: 'internal_only',
      draftedAt,
    };
  }

  /** Runs a review where the model spoofs every check's args, and returns what
   * the reviewer actually handed the tool door. */
  async function capturedTimeWindowInput(draftedAction: DraftedAction): Promise<unknown> {
    const client = scriptedClient([
      REQUIRED_CHECKS[draftedAction.actionType].map((name) => ({
        name,
        input:
          name === 'check_action_time_window'
            ? { familyId: 'SPOOFED', proposedExecutionAt: '2099-01-01T12:00:00.000Z' }
            : { familyId },
      })),
      [{ name: VERDICT_TOOL, input: { verdict: 'approve', rationale: 'clear' } }],
    ]);

    const seen: Array<{ name: string; input: unknown }> = [];
    const capturing = vi.fn(async (name: ReviewerToolName, input: unknown) => {
      seen.push({ name, input });
      return { tool: name, ok: true, result: { withinWindow: true } };
    });

    const { verdict } = await runReviewer(
      { familyId, draft: draftedAction },
      { client, invokeTool: capturing, loadChildNames: noChildNames },
    );
    expect(verdict.kind).toBe('approve');
    return seen.find((c) => c.name === 'check_action_time_window')?.input;
  }

  it("overrides the model's family and instant with the server's", async () => {
    // Kills: dropping the override and letting the model's own args through — the
    // check would then read a family and an hour the model authored (rule #3).
    const input = await capturedTimeWindowInput(
      timeWindowDraft('calendar_add', {
        title: 'Swim class',
        startsAt: '2026-07-10T14:00:00.000Z',
        endsAt: '2026-07-10T14:45:00.000Z',
      }),
    );

    expect(input).toEqual({ familyId, proposedExecutionAt: '2026-07-06T10:00:00.000Z' });
  });

  it("injects the ACTING instant, not the placement's own start time", async () => {
    // Kills: reading payload.startsAt. allowActionsBetween bounds when HALE acts,
    // not when the family's event begins — and the Sunday loop stamps every weekly
    // placement at family-local midnight (mint-placements.zonedDayStartInstant), so
    // a start-time read refuses observedHour 0 on every one of them.
    const input = await capturedTimeWindowInput(
      timeWindowDraft(
        'calendar_add',
        { title: 'Swim class', startsAt: '2026-07-13T04:00:00.000Z', endsAt: null },
        '2026-07-12T23:30:00.000Z',
      ),
    );

    expect(input).toEqual({ familyId, proposedExecutionAt: '2026-07-12T23:30:00.000Z' });
  });

  it("ignores the payload's starts_at for create_calendar_event drafts", async () => {
    // Kills: a snake_case branch surviving the switch to the acting instant — the
    // two key conventions must BOTH stop feeding this check, not just the camel one.
    const input = await capturedTimeWindowInput(
      timeWindowDraft('create_calendar_event', {
        title: '18-month visit',
        starts_at: '2026-07-10T14:00:00.000Z',
        ends_at: '2026-07-10T15:00:00.000Z',
      }),
    );

    expect(input).toEqual({ familyId, proposedExecutionAt: '2026-07-06T10:00:00.000Z' });
  });

  it('injects a value the REAL check_action_time_window contract accepts', async () => {
    // Kills: any reshaping of the instant that the shipped contract would reject —
    // zod .datetime() refusal is swallowed into ok:false, so a bad shape silently
    // flags every action of that type rather than erroring.
    const input = await capturedTimeWindowInput(
      timeWindowDraft('calendar_move', { startsAt: '2026-07-10T09:00:00-05:00' }),
    );

    expect(REVIEWER_TOOLS.check_action_time_window.input.parse(input)).toEqual({
      familyId,
      proposedExecutionAt: '2026-07-06T10:00:00.000Z',
    });
  });

  it('hands an unparseable draftedAt to the door raw, for the contract to refuse', async () => {
    // Kills: substituting a fallback instant for a malformed one — that would check
    // some OTHER moment's quiet hours and report ok:true, a silent outcome (rule #11).
    // Raw, the door's contract refuses it into a named ok:false → flag_for_human.
    const input = await capturedTimeWindowInput(
      timeWindowDraft('book_clinic_portal', { clinic: 'Riverdale Peds' }, 'tomorrow at 3'),
    );

    expect(input).toEqual({ familyId, proposedExecutionAt: 'tomorrow at 3' });
    expect(() => REVIEWER_TOOLS.check_action_time_window.input.parse(input)).toThrow();
  });

  it('shows the model no suppliable arguments for check_action_time_window', async () => {
    // Kills: restoring the permissive `additionalProperties:true` fallback schema —
    // the model would resume authoring familyId/proposedExecutionAt itself, and a
    // check whose inputs the model chooses is not a check (rule #3).
    const create = vi.fn(
      async (_req: Anthropic.MessageCreateParamsNonStreaming) => assistantMessage([]),
    );
    const client = { messages: { create } } as unknown as ReviewerAnthropicClient;

    await runReviewer(
      { familyId, draft: timeWindowDraft('calendar_add', { startsAt: '2026-07-10T14:00:00.000Z' }) },
      { client, loadChildNames: noChildNames },
    );

    const req = create.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    const tools = req.tools as Anthropic.Tool[];
    const timeWindowTool = tools.find((t) => t.name === 'check_action_time_window');
    expect(timeWindowTool?.input_schema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });
});
