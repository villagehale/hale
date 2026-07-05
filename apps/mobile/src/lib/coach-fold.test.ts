import { describe, expect, it } from 'vitest';

import { foldCoachStream } from './coach-fold';

/**
 * The batched NDJSON fold. RN's fetch has no readable body, so askHale() reads the
 * whole response text and folds the newline-delimited events post-hoc. This tests
 * the pure fold in isolation: the final answer (delta concat, cleared by reset,
 * ended by done) AND the activity trail (tool_result events → name/ok/preview).
 * Rule #1: only name/ok/preview are collected — never raw content.
 */

const NDJSON = [
  { type: 'step', step: 1 },
  { type: 'tool_call', name: 'get_child_profile' },
  { type: 'tool_result', name: 'get_child_profile', ok: true, preview: 'Ran get_child_profile' },
  { type: 'delta', text: 'intermediate reasoning that is not the answer' },
  { type: 'reset' },
  { type: 'tool_call', name: 'check_spending_cap' },
  {
    type: 'tool_result',
    name: 'check_spending_cap',
    ok: false,
    preview: 'Blocked check_spending_cap',
  },
  { type: 'delta', text: 'Naps get ' },
  { type: 'delta', text: 'shorter around now.' },
  { type: 'done', conversationId: 'conv-123' },
]
  .map((e) => JSON.stringify(e))
  .join('\n');

describe('foldCoachStream', () => {
  it('folds delta/reset/done into the final answer (reset drops the intermediate turn)', () => {
    const { answer, conversationId } = foldCoachStream(NDJSON);
    expect(answer).toBe('Naps get shorter around now.');
    expect(conversationId).toBe('conv-123');
  });

  it('collects one activity entry per tool_result, carrying name/ok/preview only', () => {
    const { activity } = foldCoachStream(NDJSON);
    expect(activity).toEqual([
      { name: 'get_child_profile', ok: true, preview: 'Ran get_child_profile' },
      { name: 'check_spending_cap', ok: false, preview: 'Blocked check_spending_cap' },
    ]);
  });

  it('ignores step/tool_call lines in the activity trail (only settled results)', () => {
    const { activity } = foldCoachStream(
      [
        { type: 'step', step: 1 },
        { type: 'tool_call', name: 'search' },
        { type: 'delta', text: 'ok' },
        { type: 'done', conversationId: 'c' },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );
    expect(activity).toEqual([]);
  });

  it('returns an empty trail and the plain answer when no tools ran', () => {
    const result = foldCoachStream(
      [
        { type: 'delta', text: 'Hello there.' },
        { type: 'done', conversationId: 'c-9' },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );
    expect(result.answer).toBe('Hello there.');
    expect(result.activity).toEqual([]);
    expect(result.conversationId).toBe('c-9');
  });

  it('flags a failed run when an error event is present', () => {
    const result = foldCoachStream(
      [{ type: 'delta', text: 'partial' }, { type: 'error' }]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );
    expect(result.failed).toBe(true);
  });

  it('collects the gated action chips carried on the done event (kind/label/actionType)', () => {
    const { actionIntents } = foldCoachStream(
      [
        { type: 'delta', text: 'You could email the clinic.' },
        {
          type: 'done',
          conversationId: 'c-1',
          actionIntents: [
            { kind: 'draft_email', label: 'Email the clinic', actionType: 'send_email' },
          ],
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );
    expect(actionIntents).toEqual([
      { kind: 'draft_email', label: 'Email the clinic', actionType: 'send_email' },
    ]);
  });

  it('returns an empty chip list when the done event carries no actionIntents', () => {
    const { actionIntents } = foldCoachStream(
      [
        { type: 'delta', text: 'Naps get shorter around now.' },
        { type: 'done', conversationId: 'c-2' },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );
    expect(actionIntents).toEqual([]);
  });
});
