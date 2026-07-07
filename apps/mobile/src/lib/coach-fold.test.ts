import { describe, expect, it } from 'vitest';

import {
  type CoachEvent,
  createNdjsonSplitter,
  foldCoachEvents,
  foldCoachStream,
  humanizeTool,
} from './coach-fold';

describe('humanizeTool', () => {
  it('maps known tools to a friendly, parent-facing label', () => {
    expect(humanizeTool('search_village')).toBe('Searched your village');
    expect(humanizeTool('get_child_profile')).toBe('Read your child’s profile');
  });

  it('never leaks a raw snake_case name — unknown tools are de-snaked + sentence-cased', () => {
    expect(humanizeTool('some_new_tool')).toBe('Some new tool');
    expect(humanizeTool('some_new_tool')).not.toContain('_');
  });
});

/**
 * The batched NDJSON fold. RN's fetch has no readable body, so runConcierge() reads the
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

/**
 * The incremental parser. The real transport reads response.body.getReader() and
 * feeds decoded chunks in as they arrive — and chunk boundaries fall wherever the
 * network splits, NOT on line boundaries. So the splitter must buffer a partial
 * line across pushes, emit a complete event the instant its newline arrives, and
 * fold to EXACTLY the same result as reading the whole body at once. These drive
 * the same body through pathological chunk boundaries and assert order + fold.
 */

/** Feed a body to the splitter split at the given absolute character offsets,
 * collecting every event in the order it's emitted (plus the flushed tail). */
function drive(body: string, breakpoints: number[]): CoachEvent[] {
  const splitter = createNdjsonSplitter();
  const events: CoachEvent[] = [];
  let last = 0;
  for (const bp of [...breakpoints, body.length]) {
    events.push(...splitter.push(body.slice(last, bp)));
    last = bp;
  }
  events.push(...splitter.flush());
  return events;
}

describe('createNdjsonSplitter', () => {
  const BODY = [
    { type: 'step', step: 1 },
    { type: 'tool_call', name: 'get_child_profile' },
    { type: 'tool_result', name: 'get_child_profile', ok: true, preview: 'Ran get_child_profile' },
    { type: 'delta', text: 'Naps get ' },
    { type: 'delta', text: 'shorter around now.' },
    { type: 'done', conversationId: 'conv-1' },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  // The server terminates every event with a newline; include the trailing one.
  const WIRE = `${BODY}\n`;

  const expected: CoachEvent[] = [
    { type: 'step', step: 1 },
    { type: 'tool_call', name: 'get_child_profile' },
    { type: 'tool_result', name: 'get_child_profile', ok: true, preview: 'Ran get_child_profile' },
    { type: 'delta', text: 'Naps get ' },
    { type: 'delta', text: 'shorter around now.' },
    { type: 'done', conversationId: 'conv-1' },
  ];

  it('emits nothing until a line is completed by its newline', () => {
    const splitter = createNdjsonSplitter();
    const firstLine = JSON.stringify({ type: 'delta', text: 'hi' });
    // A chunk that ends mid-line (before the newline) yields no event yet…
    expect(splitter.push(firstLine.slice(0, 5))).toEqual([]);
    expect(splitter.push(firstLine.slice(5))).toEqual([]);
    // …only the newline flushes the buffered line as one event.
    expect(splitter.push('\n')).toEqual([{ type: 'delta', text: 'hi' }]);
  });

  it('emits both events when two complete lines arrive in a single chunk', () => {
    const splitter = createNdjsonSplitter();
    const chunk = `${JSON.stringify({ type: 'step', step: 1 })}\n${JSON.stringify({
      type: 'reset',
    })}\n`;
    expect(splitter.push(chunk)).toEqual([{ type: 'step', step: 1 }, { type: 'reset' }]);
  });

  it('yields the same ordered events no matter where the chunk boundaries fall', () => {
    // Whole-body, byte-at-a-time, split inside a JSON token, and split exactly on
    // the newline — all must reduce to the identical event sequence.
    const byteAtATime = drive(
      WIRE,
      Array.from({ length: WIRE.length }, (_, i) => i),
    );
    const midToken = drive(WIRE, [3, 20, 47, 61, 88, 140]);
    const onNewlines = drive(
      WIRE,
      [...WIRE].flatMap((ch, i) => (ch === '\n' ? [i, i + 1] : [])),
    );

    expect(drive(WIRE, [])).toEqual(expected);
    expect(byteAtATime).toEqual(expected);
    expect(midToken).toEqual(expected);
    expect(onNewlines).toEqual(expected);
  });

  it('folds a chunk-by-chunk stream to the same answer/trail as the whole body', () => {
    const streamed = foldCoachEvents(
      drive(
        WIRE,
        Array.from({ length: WIRE.length }, (_, i) => i),
      ),
    );
    const batched = foldCoachStream(BODY);
    expect(streamed).toEqual(batched);
    expect(streamed.answer).toBe('Naps get shorter around now.');
    expect(streamed.conversationId).toBe('conv-1');
    expect(streamed.activity).toEqual([
      { name: 'get_child_profile', ok: true, preview: 'Ran get_child_profile' },
    ]);
  });

  it('flushes a final line the stream never terminated with a newline', () => {
    const splitter = createNdjsonSplitter();
    expect(splitter.push(JSON.stringify({ type: 'delta', text: 'tail' }))).toEqual([]);
    expect(splitter.flush()).toEqual([{ type: 'delta', text: 'tail' }]);
  });
});
