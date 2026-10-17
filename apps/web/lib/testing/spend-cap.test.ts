import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capSdkClient, cappedCall, readLedger, usageUsd, worstCaseUsd } from './spend-cap.mjs';

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
  const create = vi.fn(async (_req?: unknown) =>
    message({ input_tokens: 1000, output_tokens: 200 }),
  );
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
  it('disables unaccounted SDK retries and preserves request options for create and stream', async () => {
    vi.stubEnv('HALE_MAX_USD', '1');
    const m = mockClient();
    const wrapped = capSdkClient(m.client, { rates });
    const signal = new AbortController().signal;
    await wrapped.messages.create(request, { signal, maxRetries: 2 });
    expect(m.create).toHaveBeenCalledWith(request, { signal, maxRetries: 0 });
    await wrapped.messages.stream(request, { signal }).finalMessage();
    expect(m.stream).toHaveBeenCalledWith(request, { signal, maxRetries: 0 });
    expect(readLedger().calls).toBe(2);
  });
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
    expect(readLedger().log.at(-1)).toMatchObject({ refused: true, projected: expect.any(Number) });
    await expect(
      cappedCall({
        client: m.client,
        request: { ...request, max_tokens: 1 },
        call: () => m.client.messages.create(request),
        rates,
      }),
    ).rejects.toThrow(/previous refusal/);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('can retry a repaired token-count preflight without clearing its zero-spend failure audit', async () => {
    vi.stubEnv('HALE_MAX_USD', '1');
    const m = mockClient();
    m.countTokens.mockRejectedValueOnce(new Error('preflight unavailable'));
    const args = {
      client: m.client,
      request,
      call: () => m.client.messages.create(request),
      rates,
    };
    await expect(cappedCall(args)).rejects.toThrow(/could not count/);
    expect(m.create).not.toHaveBeenCalled();
    expect(readLedger().spentUsd).toBe(0);
    await cappedCall(args);
    expect(readLedger().refused).toBe(1);
    expect(readLedger().calls).toBe(1);
    expect(readLedger().log[0]).toMatchObject({
      refused: true,
      countError: 'preflight unavailable',
    });
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

  // The Oct 13 #864 round: activity-ground calls carried web_search (and web_fetch for a
  // named venue). Their first turn counted ~7.5k-11.8k input tokens; the bill was
  // 60k-232k input plus a fee per search. Each row: counted input, tools, real usage.
  const sonnet = () => ({ input: 3, output: 15 });
  const search = { name: 'web_search', type: 'web_search_20250305', max_uses: 3 };
  const fetch = { name: 'web_fetch', type: 'web_fetch_20260209', max_uses: 3 };
  const ground = [
    [
      7520,
      [search],
      { input_tokens: 95073, output_tokens: 1784, server_tool_use: { web_search_requests: 3 } },
    ],
    [
      7520,
      [search],
      { input_tokens: 98813, output_tokens: 5199, server_tool_use: { web_search_requests: 3 } },
    ],
    [
      7520,
      [search],
      { input_tokens: 62778, output_tokens: 5019, server_tool_use: { web_search_requests: 3 } },
    ],
    [
      11787,
      [search, fetch],
      {
        input_tokens: 232232,
        output_tokens: 3077,
        server_tool_use: { web_search_requests: 3, web_fetch_requests: 6 },
      },
    ],
  ] as const;

  it('projects a server-tool call above what the Oct 13 calls really cost', () => {
    for (const [counted, tools, usage] of ground) {
      const req = { ...request, model: 'claude-sonnet-5', max_tokens: 4096, tools: [...tools] };
      // The ceiling charged before the call. Counted input alone is the $0.084 first
      // turn; a search turn is priced at 250k input tokens plus max_uses × $0.01.
      expect(worstCaseUsd(sonnet, req, counted)).toBeGreaterThanOrEqual(
        usageUsd(sonnet, req.model, usage),
      );
    }
  });

  it('books web search fees', () => {
    expect(
      usageUsd(sonnet, 'claude-sonnet-5', {
        input_tokens: 0,
        output_tokens: 0,
        server_tool_use: { web_search_requests: 21 },
      } as never),
    ).toBeCloseTo(0.21, 6);
  });

  it('refuses a search call the first turn alone would have let through', async () => {
    vi.stubEnv('HALE_MAX_USD', '0.30');
    const m = mockClient(7520);
    const req = { ...request, model: 'claude-sonnet-5', max_tokens: 4096, tools: [search] };
    // First turn only: 7520 in + 4096 out = $0.084, under the cap; the real call was $0.34.
    await expect(
      cappedCall({
        client: m.client,
        request: req,
        call: () => m.client.messages.create(req),
        rates: sonnet,
      }),
    ).rejects.toThrow(/refusing/);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('refuses a server tool with no max_uses', async () => {
    vi.stubEnv('HALE_MAX_USD', '100');
    const m = mockClient();
    const req = { ...request, tools: [{ name: 'web_search', type: 'web_search_20250305' }] };
    await expect(
      cappedCall({
        client: m.client,
        request: req,
        call: () => m.client.messages.create(req),
        rates,
      }),
    ).rejects.toThrow(/max_uses/);
    expect(m.create).not.toHaveBeenCalled();
  });
});
