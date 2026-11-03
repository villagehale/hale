import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAIM_READ_PROBE_CASES,
  probeExitFor,
  runClaimReadProbe,
  runClaimReadWarm,
} from './claim-read-probe';
import { type ClaimReadInput, type ClaimReader, createClaimReader } from './claim-reader';

/**
 * VIL-581 · the warm and probe modes behind /api/cron/claim-read-warm. Fakes sit only at
 * the AgentClient and ClaimReader ports; the probe's verdicts go through the real
 * verifier.
 */

function message(text: string): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: 'text', text }],
  } as unknown as Anthropic.Message;
}
const NO_CLAIMS = message(JSON.stringify({ reason: 'r', claims: [] }));

function fakeClient(...steps: Array<Anthropic.Message | Error>) {
  const create = vi.fn(async (_body: unknown, _options?: unknown) => {
    const step = steps.shift();
    if (!step) throw new Error('fake client: no step left');
    if (step instanceof Error) throw step;
    return step;
  });
  return { client: { messages: { create } } as unknown as AgentClient, create };
}

const readersOver = (client: AgentClient) => ({
  adaptive: createClaimReader({
    client,
    wait: async () => {},
    clock: Date.now,
    thinking: 'adaptive',
  }),
  off: createClaimReader({ client, wait: async () => {}, clock: Date.now, thinking: 'off' }),
});

/** A scripted reader that answers each probe case by its body: the correct citation, or
 * a wrong one for the cases named in `wrong`. */
function scriptedReader(wrong: ReadonlySet<string> = new Set()): ClaimReader {
  return {
    async read(input: ClaimReadInput) {
      const probe = CLAIM_READ_PROBE_CASES.find((c) => c.body === input.body);
      if (!probe) throw new Error('scripted reader: unknown body');
      const backed = probe.expected === 'backed' ? !wrong.has(probe.id) : wrong.has(probe.id);
      const { segmentSentences } = await import('./sentences');
      return {
        status: 'read',
        segments: segmentSentences(input.body, input.language ?? undefined),
        claims: [{ segment: 0, kind: 'scheduled_event', row: backed ? 'e1' : 'none' }],
        usage: { input: 0, output: 0 },
        latencyMs: 7,
        attempts: 1,
      };
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('runClaimReadWarm', () => {
  it('skips with the reader off and makes no call', async () => {
    const { client, create } = fakeClient();
    expect(await runClaimReadWarm({ readers: readersOver(client), mode: 'off' })).toEqual({
      mode: 'warm',
      skipped: 'reader_off',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('reads once per lane through one request builder', async () => {
    const { client, create } = fakeClient(NO_CLAIMS, NO_CLAIMS);
    const result = await runClaimReadWarm({ readers: readersOver(client), mode: 'shadow' });
    expect(result).toMatchObject({
      mode: 'warm',
      reads: [
        { lane: 'adaptive', outcome: 'read' },
        { lane: 'off', outcome: 'read' },
      ],
    });
    const [first, second] = create.mock.calls.map(([body]) => body as Record<string, unknown>);
    expect(first?.thinking).toEqual({ type: 'adaptive' });
    expect(second?.thinking).toEqual({ type: 'disabled' });
    expect(second?.messages).toEqual(first?.messages);
    expect(second?.output_config).toMatchObject({
      format: (first?.output_config as { format: unknown }).format,
    });
    expect(second?.system).toEqual(first?.system);
  });

  it('names a failed lane by its outcome', async () => {
    const down = () =>
      Anthropic.APIError.generate(
        503,
        { type: 'error', error: { type: 'api_error', message: 'x' } },
        undefined,
        {},
      );
    const { client } = fakeClient(down(), down(), NO_CLAIMS);
    const result = await runClaimReadWarm({ readers: readersOver(client), mode: 'enforce' });
    expect(result).toMatchObject({
      reads: [
        { lane: 'adaptive', outcome: 'unreachable' },
        { lane: 'off', outcome: 'read' },
      ],
    });
  });
});

describe('runClaimReadProbe', () => {
  it('has a false booking and a true-row control in en, fr, zh and es', () => {
    expect(CLAIM_READ_PROBE_CASES).toHaveLength(8);
    for (const language of ['en', 'fr', 'zh', 'es']) {
      expect(
        CLAIM_READ_PROBE_CASES.filter((c) => c.language === language)
          .map((c) => c.expected)
          .sort(),
      ).toEqual(['backed', 'refused']);
    }
  });

  it('passes a reader that cites correctly', async () => {
    const result = await runClaimReadProbe({ reader: scriptedReader() });
    expect(result.ok).toBe(true);
    expect(result.cases).toHaveLength(8);
    expect(result.cases.every((c) => c.got === c.expected)).toBe(true);
  });

  it('fails a reader that backs the English false booking (control)', async () => {
    const result = await runClaimReadProbe({ reader: scriptedReader(new Set(['en-false'])) });
    expect(result.ok).toBe(false);
    expect(result.cases.find((c) => c.id === 'en-false')?.got).toBe('backed');
  });

  it('names a failed read as failed, never as a verdict', async () => {
    const failing: ClaimReader = {
      read: async () => ({ status: 'failed', reason: 'unreachable', attempts: 2, latencyMs: 3 }),
    };
    const result = await runClaimReadProbe({ reader: failing });
    expect(result.ok).toBe(false);
    expect(new Set(result.cases.map((c) => c.got))).toEqual(new Set(['failed:unreachable']));
  });
});

describe('probeExitFor', () => {
  const correct = async () => runClaimReadProbe({ reader: scriptedReader() });

  it('a Preview skip is not run: exit 2', () => {
    const out = probeExitFor(200, { ok: true, skipped: 'preview_cron_not_scoped' });
    expect(out.code).toBe(2);
    expect(out.lines).toEqual(['probe: not run (preview_cron_not_scoped)']);
  });

  it('a non-200 or a body with no cases is not run: exit 2', () => {
    expect(probeExitFor(401, { error: 'unauthorized' })).toEqual({
      code: 2,
      lines: ['probe: not run (http 401)'],
    });
    expect(probeExitFor(200, { mode: 'warm', skipped: undefined })).toEqual({
      code: 2,
      lines: ['probe: not run (no_cases)'],
    });
  });

  it('a wrong verdict exits 1', async () => {
    const body = await runClaimReadProbe({ reader: scriptedReader(new Set(['zh-true'])) });
    expect(probeExitFor(200, body).code).toBe(1);
  });

  it('eight correct verdicts exit 0, one line each (control)', async () => {
    const out = probeExitFor(200, await correct());
    expect(out.code).toBe(0);
    expect(out.lines).toHaveLength(8);
  });
});
