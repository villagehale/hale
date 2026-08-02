import type { AgentClient } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { MIN_SURFACE_CONFIDENCE, parseCivicHours } from './parse-hours';

/**
 * VIL-252 · M16 — the two-stage parse, and the gate that makes an invented time
 * unable to reach a parent.
 *
 * These test MECHANICS with an injected fake, which is the repo's established
 * split (see pipeline/structured.ts): the client is injected so wiring is
 * testable, while the model's QUALITY is an eval against real cached Claude
 * (rule #8) — apps/worker/evals/run-civic-hours-eval.mjs. Nothing here asserts
 * that the model is good at reading schedules; it asserts that when the model is
 * WRONG, the wrong answer does not survive.
 */

/** A client that returns one fixed tool payload, and records that it was used. */
function fakeClient(payload: unknown): { client: AgentClient; calls: () => number } {
  let calls = 0;
  const client = {
    messages: {
      create: async () => {
        calls += 1;
        return {
          content: [{ type: 'tool_use', name: 'weekly_slots', input: payload }],
          usage: { input_tokens: 10, output_tokens: 10 },
        };
      },
    },
  } as unknown as AgentClient;
  return { client, calls: () => calls };
}

/** Any call to this is a bug: the strict parser should have handled the text. */
const forbiddenClient = {
  messages: {
    create: async () => {
      throw new Error('the model must not be called when the strict parser succeeds');
    },
  },
} as unknown as AgentClient;

describe('parseCivicHours — deterministic first', () => {
  it('reads well-formed municipal text with no model call at all', async () => {
    const result = await parseCivicHours(
      'Monday: 9:30 a.m. - 11:30 a.m.  ; 1:30 p.m. - 3:30 p.m.',
      { client: forbiddenClient },
    );
    expect(result.extraction).toBe('structured');
    expect(result.confidence).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.slots).toEqual([
      { dayOfWeek: 1, startMinute: 9 * 60 + 30, endMinute: 11 * 60 + 30 },
      { dayOfWeek: 1, startMinute: 13 * 60 + 30, endMinute: 15 * 60 + 30 },
    ]);
  });
});

describe('parseCivicHours — the corroboration gate', () => {
  const prose = 'Drop-in play runs Tuesdays from 10:00 a.m. to noon.';

  it('accepts a slot the source text actually supports', async () => {
    const { client, calls } = fakeClient({
      slots: [{ day: 'tuesday', start: '10:00', end: '12:00', confidence: 0.95 }],
    });
    const result = await parseCivicHours(prose, { client });
    expect(calls()).toBe(1);
    expect(result.extraction).toBe('llm');
    expect(result.slots).toEqual([{ dayOfWeek: 2, startMinute: 600, endMinute: 720 }]);
    expect(result.rejected).toBe(0);
    // Never 1: a model reading that agrees with the source is still a reading.
    expect(result.confidence).toBeLessThan(1);
    expect(result.confidence).toBeGreaterThanOrEqual(MIN_SURFACE_CONFIDENCE);
  });

  it('DROPS a fabricated time even when the model is confident about it', async () => {
    // 3:00 p.m. appears nowhere in the source. High stated confidence must not
    // buy a slot past the gate — that is the entire point of checking.
    const { client } = fakeClient({
      slots: [{ day: 'tuesday', start: '10:00', end: '15:00', confidence: 0.99 }],
    });
    const result = await parseCivicHours(prose, { client });
    expect(result.slots).toEqual([]);
    expect(result.rejected).toBe(1);
    // No surviving slot means nothing to be confident about.
    expect(result.confidence).toBe(0);
  });

  it('DROPS a slot placed on a day the source never vouches for', async () => {
    const { client } = fakeClient({
      slots: [{ day: 'saturday', start: '10:00', end: '12:00', confidence: 0.9 }],
    });
    const result = await parseCivicHours(prose, { client });
    expect(result.slots).toEqual([]);
    expect(result.rejected).toBe(1);
  });

  it('keeps the good slots and drops only the unsupported ones', async () => {
    const source = 'Tuesdays 10:00 a.m. to noon, Thursdays 1:00 p.m. to 3:00 p.m.';
    const { client } = fakeClient({
      slots: [
        { day: 'tuesday', start: '10:00', end: '12:00', confidence: 0.95 },
        { day: 'thursday', start: '13:00', end: '15:00', confidence: 0.95 },
        { day: 'friday', start: '09:00', end: '11:00', confidence: 0.95 },
      ],
    });
    const result = await parseCivicHours(source, { client });
    expect(result.slots).toEqual([
      { dayOfWeek: 2, startMinute: 600, endMinute: 720 },
      { dayOfWeek: 4, startMinute: 780, endMinute: 900 },
    ]);
    expect(result.rejected).toBe(1);
  });

  it('carries the LEAST certain surviving slot’s confidence', async () => {
    const source = 'Tuesdays 10:00 a.m. to noon, Thursdays 1:00 p.m. to 3:00 p.m.';
    const { client } = fakeClient({
      slots: [
        { day: 'tuesday', start: '10:00', end: '12:00', confidence: 0.95 },
        { day: 'thursday', start: '13:00', end: '15:00', confidence: 0.4 },
      ],
    });
    const result = await parseCivicHours(source, { client });
    // One shaky reading in a centre's week is a reason to doubt that week — and
    // 0.4 is below the surfacing floor, so this centre stays silent.
    expect(result.confidence).toBe(0.4);
    expect(result.confidence).toBeLessThan(MIN_SURFACE_CONFIDENCE);
  });

  it('rejects a malformed time rather than coercing it', async () => {
    const { client } = fakeClient({
      slots: [
        { day: 'tuesday', start: '10:00', end: '25:99', confidence: 0.9 },
        { day: 'tuesday', start: '12:00', end: '10:00', confidence: 0.9 },
      ],
    });
    const result = await parseCivicHours(prose, { client });
    expect(result.slots).toEqual([]);
    expect(result.rejected).toBe(2);
  });

  it('returns nothing when the model honestly reports no schedule', async () => {
    const { client } = fakeClient({ slots: [] });
    const result = await parseCivicHours('Please contact the centre for details.', { client });
    expect(result.slots).toEqual([]);
    expect(result.rejected).toBe(0);
  });
});
