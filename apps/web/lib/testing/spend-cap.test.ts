import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cappedCall, readLedger } from './spend-cap.mjs';

const rates = () => ({ input: 1, output: 5 }); // $ per MTok
const request = {
  model: 'claude-haiku-4-5',
  max_tokens: 1000,
  messages: [{ role: 'user', content: 'hi' }],
};
const message = (usage: Record<string, number>) => ({
  content: [],
  stop_reason: 'end_turn',
  usage,
});

function mockClient(inputTokens = 1000) {
  const countTokens = vi.fn(async (_req?: unknown) => ({ input_tokens: inputTokens }));
  const create = vi.fn(async (_req?: unknown) => message({ input_tokens: 1000, output_tokens: 200 }));
  const finalMessage = vi.fn(async () => message({ input_tokens: 1000, output_tokens: 400 }));
  const stream = vi.fn((_req?: unknown) => ({ finalMessage }));
  return {
    client: { messages: { countTokens, create, stream } },
    countTokens,
    create,
    stream,
    finalMessage,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spend-cap-'));
  vi.stubEnv('HALE_SPEND_LEDGER', join(dir, 'ledger.json'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('spend cap at the call site', () => {
  it('is exactly the call when no cap is set', async () => {
    const m = mockClient();
    await cappedCall({
      client: m.client,
      request,
      call: () => m.client.messages.create(request),
      rates,
    });
    expect(m.countTokens).not.toHaveBeenCalled();
    expect(m.create).toHaveBeenCalledTimes(1);
  });

  it('books the real usage from the returned message', async () => {
    vi.stubEnv('HALE_MAX_USD', '1');
    const m = mockClient();
    await cappedCall({
      client: m.client,
      request,
      call: () => m.client.messages.create(request),
      rates,
    });
    const l = readLedger();
    // projected 1000 in + 1000 out = $0.006; real 1000 in + 200 out = $0.002
    expect(l.spentUsd).toBeCloseTo(0.002, 9);
    expect(l.reservedUsd).toBe(0);
    expect(l.calls).toBe(1);
  });

  it('refuses BEFORE the call when the projection would cross the cap', async () => {
    vi.stubEnv('HALE_MAX_USD', '0.005'); // projection is $0.006
    const m = mockClient();
    await expect(
      cappedCall({
        client: m.client,
        request,
        call: () => m.client.messages.create(request),
        rates,
      }),
    ).rejects.toThrow(/refusing/);
    expect(m.create).not.toHaveBeenCalled();
    expect(readLedger().refused).toBe(1);
  });

  it('counts what is already spent against the next projection', async () => {
    vi.stubEnv('HALE_MAX_USD', '0.0075');
    const m = mockClient();
    const call = () => m.client.messages.create(request);
    await cappedCall({ client: m.client, request, call, rates }); // spent 0.002
    await expect(cappedCall({ client: m.client, request, call, rates })).rejects.toThrow(
      /refusing/,
    );
    expect(m.create).toHaveBeenCalledTimes(1); // 0.002 spent + 0.006 projected > 0.0075
  });

  it('reads usage off a stream through its own finalMessage, never touching the stream', async () => {
    vi.stubEnv('HALE_MAX_USD', '1');
    const m = mockClient();
    await cappedCall({
      client: m.client,
      request,
      call: () => m.client.messages.stream(request).finalMessage(),
      rates,
    });
    expect(m.finalMessage).toHaveBeenCalledTimes(1);
    expect(readLedger().spentUsd).toBeCloseTo(0.003, 9); // 1000 in + 400 out
  });

  it('prices a cache_control request at the cache-write rate', async () => {
    vi.stubEnv('HALE_MAX_USD', '0.00624');
    const m = mockClient();
    const cachedReq = {
      ...request,
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
    };
    // 1000 * 1.25 + 1000 * 5 = $0.00625 > cap
    await expect(
      cappedCall({
        client: m.client,
        request: cachedReq,
        call: () => m.client.messages.create(cachedReq),
        rates,
      }),
    ).rejects.toThrow(/refusing/);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('books the projection when the call fails after it was sent', async () => {
    vi.stubEnv('HALE_MAX_USD', '1');
    const m = mockClient();
    m.create.mockRejectedValueOnce(new Error('Premature close'));
    await expect(
      cappedCall({
        client: m.client,
        request,
        call: () => m.client.messages.create(request),
        rates,
      }),
    ).rejects.toThrow(/Premature/);
    const l = readLedger();
    expect(l.spentUsd).toBeCloseTo(0.006, 9);
    expect(l.reservedUsd).toBe(0);
  });

  it('halts the round on an auth error and refuses every later call', async () => {
    vi.stubEnv('HALE_MAX_USD', '1');
    const m = mockClient();
    m.countTokens.mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 401 }));
    const call = () => m.client.messages.create(request);
    await expect(cappedCall({ client: m.client, request, call, rates })).rejects.toThrow(
      /auth error 401/,
    );
    await expect(cappedCall({ client: m.client, request, call, rates })).rejects.toThrow(/halted/);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('estimate mode never calls the model and returns a schema-shaped stand-in', async () => {
    vi.stubEnv('HALE_ESTIMATE', '1');
    const m = mockClient();
    const toolReq = {
      ...request,
      tools: [
        {
          name: 'score',
          input_schema: {
            type: 'object',
            properties: {
              reason: { type: 'string' },
              score: { type: 'integer', minimum: 1, maximum: 5 },
            },
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'score' },
    };
    const out = (await cappedCall({
      client: m.client,
      request: toolReq,
      call: () => m.client.messages.create(toolReq),
      rates,
    })) as { content: Array<{ type: string; input?: unknown }> };
    expect(m.create).not.toHaveBeenCalled();
    expect(out.content[0]).toMatchObject({
      type: 'tool_use',
      input: { reason: 'estimate', score: 5 },
    });
    const l = readLedger();
    expect(l.estimated).toBe(1);
    expect(l.estimateUsd).toBeCloseTo(0.006, 9);
  });
});

describe('spend cap when tokens cannot be counted', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it('refuses the call rather than guessing', async () => {
    vi.stubEnv('HALE_SPEND_LEDGER', join(mkdtempSync(join(tmpdir(), 'spend-cap-')), 'l.json'));
    vi.stubEnv('HALE_MAX_USD', '1');
    const m = mockClient();
    m.countTokens.mockRejectedValueOnce(new Error('Premature close'));
    await expect(
      cappedCall({
        client: m.client,
        request,
        call: () => m.client.messages.create(request),
        rates,
      }),
    ).rejects.toThrow(/could not count tokens/);
    expect(m.create).not.toHaveBeenCalled();
  });
});
