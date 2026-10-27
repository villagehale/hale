import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SEARCH_WORST_INPUT_TOKENS,
  USD_PER_WEB_SEARCH,
  capSdkClient,
  cappedCall,
  installSpendCap,
  isSpendCapStop,
  readCapUsd,
  readLedger,
  worstCaseUsd,
} from '../../../web/lib/testing/spend-cap.mjs';

const rates = () => ({ input: 2, output: 10 });
const request = {
  model: 'claude-sonnet-5-5',
  max_tokens: 1000,
  messages: [{ role: 'user', content: 'hi' }],
};
const searchRequest = {
  ...request,
  max_tokens: 4096,
  tools: [{ name: 'web_search', type: 'web_search_20250305', max_uses: 2 }],
};

function message(usage) {
  return { content: [], stop_reason: 'end_turn', usage };
}

function mockClient(inputTokens = 1000) {
  const countTokens = vi.fn(async () => ({ input_tokens: inputTokens }));
  const create = vi.fn(async () => message({ input_tokens: 1000, output_tokens: 200 }));
  const stream = vi.fn(() => ({
    finalMessage: vi.fn(async () =>
      message({
        input_tokens: 8000,
        output_tokens: 400,
        server_tool_use: { web_search_requests: 2 },
      }),
    ),
  }));
  return { client: { messages: { countTokens, create, stream } }, countTokens, create, stream };
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spend-cap-'));
  vi.stubEnv('HALE_SPEND_LEDGER', join(dir, 'ledger.json'));
  vi.stubEnv('HALE_MAX_USD', '');
  vi.stubEnv('HALE_ESTIMATE', '');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('the ceiling', () => {
  it('is off until HALE_MAX_USD or --max-usd is set', () => {
    expect(readCapUsd(['node', 'eval.mjs'], {})).toBeNull();
  });

  it('reads either source, and the lower one wins', () => {
    expect(readCapUsd(['node', 'eval.mjs', '--max-usd=0.5'], { HALE_MAX_USD: '2' })).toBe(0.5);
    expect(readCapUsd(['node', 'eval.mjs', '--max-usd', '1.25'], {})).toBe(1.25);
    expect(readCapUsd(['node', 'eval.mjs'], { HALE_MAX_USD: '2.42' })).toBe(2.42);
  });

  it('rejects a ceiling that is not a number', () => {
    expect(() => readCapUsd(['node', 'eval.mjs', '--max-usd=nope'], {})).toThrow(/--max-usd/);
    expect(() => readCapUsd(['node', 'eval.mjs'], { HALE_MAX_USD: '-1' })).toThrow(/HALE_MAX_USD/);
  });

  it('installs the lower ceiling and a ledger before any call', () => {
    vi.stubEnv('HALE_MAX_USD', '2');
    vi.stubEnv('HALE_SPEND_LEDGER', '');
    const cap = installSpendCap(['node', 'eval.mjs', '--max-usd=0.4']);
    expect(cap).toBe(0.4);
    expect(process.env.HALE_MAX_USD).toBe('0.4');
    expect(process.env.HALE_SPEND_LEDGER).toBe('/tmp/hale-eval-spend.json');
    vi.stubEnv('HALE_SPEND_LEDGER', join(dir, 'ledger.json'));
  });
});

describe('a cap stop', () => {
  it('is the error a runner prints past, instead of crashing', () => {
    expect(isSpendCapStop(new Error('spend-cap: refusing general-answer'))).toBe(true);
    expect(isSpendCapStop(new Error('spend-cap: round halted (auth); refusing x'))).toBe(true);
    expect(isSpendCapStop(new Error('cache miss'))).toBe(false);
    expect(isSpendCapStop('spend-cap: refusing')).toBe(false);
  });
});

describe('worst case', () => {
  it('prices a search turn as max_uses fees plus 250k input tokens and the output budget', () => {
    const projected = worstCaseUsd(rates, searchRequest, 12);
    const expected =
      (SEARCH_WORST_INPUT_TOKENS * 2 + searchRequest.max_tokens * 10) / 1e6 +
      2 * USD_PER_WEB_SEARCH;
    expect(projected).toBeCloseTo(expected, 9);
    expect(projected).toBeGreaterThan(0.5);
  });

  it('prices any other turn from the counted input, not the search ceiling', () => {
    const projected = worstCaseUsd(rates, request, 1000);
    expect(projected).toBeCloseTo((1000 * 2 + 1000 * 10) / 1e6, 9);
  });
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

  it('refuses before the call when spent plus the worst case would cross the cap', async () => {
    vi.stubEnv('HALE_MAX_USD', '0.01');
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

  it('stops the next call before making it once the booked spend is too close', async () => {
    vi.stubEnv('HALE_MAX_USD', '0.015');
    const m = mockClient();
    const call = () => m.client.messages.create(request);
    await cappedCall({ client: m.client, request, call, rates });
    await expect(cappedCall({ client: m.client, request, call, rates })).rejects.toThrow(
      /refusing/,
    );
    expect(m.create).toHaveBeenCalledTimes(1);
  });

  it('books server_tool_use.web_search_requests at $0.01 after the call', async () => {
    vi.stubEnv('HALE_MAX_USD', '2');
    const m = mockClient();
    const guarded = capSdkClient(m.client, { rates, tag: 'general-answer' });
    await guarded.messages.stream(searchRequest).finalMessage();
    const ledger = readLedger();
    // 8000 in × $2 + 400 out × $10, plus 2 searches.
    expect(ledger.spentUsd).toBeCloseTo((8000 * 2 + 400 * 10) / 1e6 + 0.02, 9);
    expect(ledger.reservedUsd).toBe(0);
    expect(ledger.calls).toBe(1);
    expect(m.countTokens).not.toHaveBeenCalled();
    expect(m.stream).toHaveBeenCalledTimes(1);
  });

  it('does not open a search stream when the 250k worst case would cross the cap', async () => {
    vi.stubEnv('HALE_MAX_USD', '0.5');
    const m = mockClient();
    const guarded = capSdkClient(m.client, { rates, tag: 'general-answer' });
    await expect(guarded.messages.stream(searchRequest).finalMessage()).rejects.toThrow(/refusing/);
    expect(m.stream).not.toHaveBeenCalled();
    expect(m.countTokens).not.toHaveBeenCalled();
    expect(readLedger().refused).toBe(1);
  });

  it('refuses an activity-deep research turn before the stream is opened', async () => {
    vi.stubEnv('HALE_MAX_USD', '0.5');
    const m = mockClient();
    const research = {
      model: 'claude-sonnet-5-5',
      max_tokens: 8192,
      system: 'research',
      tools: [
        { name: 'web_search', type: 'web_search_20250305', max_uses: 4 },
        { name: 'web_fetch', type: 'web_fetch_20260209', max_uses: 4 },
      ],
      messages: [{ role: 'user', content: '{"mode":"deep_research"}' }],
    };
    const guarded = capSdkClient(m.client, { rates, tag: 'activity-deep' });
    await expect(guarded.messages.stream(research).finalMessage()).rejects.toThrow(/refusing/);
    expect(m.stream).not.toHaveBeenCalled();
    expect(m.countTokens).not.toHaveBeenCalled();
    const ledger = readLedger();
    expect(ledger.refused).toBe(1);
    expect(ledger.calls).toBe(0);
    expect(ledger.spentUsd).toBe(0);
    expect(ledger.log[0].tag).toBe('activity-deep:search');
  });

  it('books a research turn search fee once, including when the client is wrapped twice', async () => {
    vi.stubEnv('HALE_MAX_USD', '2');
    const m = mockClient();
    m.stream.mockImplementation(() => ({
      finalMessage: async () =>
        message({
          input_tokens: 8000,
          output_tokens: 400,
          server_tool_use: { web_search_requests: 4 },
        }),
    }));
    const research = {
      model: 'claude-sonnet-5-5',
      max_tokens: 8192,
      tools: [
        { name: 'web_search', type: 'web_search_20250305', max_uses: 4 },
        { name: 'web_fetch', type: 'web_fetch_20260209', max_uses: 4 },
      ],
      messages: [{ role: 'user', content: 'deep' }],
    };
    const guarded = capSdkClient(capSdkClient(m.client, { rates, tag: 'eval' }), {
      rates,
      tag: 'activity-deep',
    });
    await guarded.messages.stream(research).finalMessage();
    const ledger = readLedger();
    expect(m.stream).toHaveBeenCalledTimes(1);
    expect(ledger.calls).toBe(1);
    expect(ledger.log[0].tag).toBe('activity-deep:search');
    expect(ledger.spentUsd).toBeCloseTo((8000 * 2 + 400 * 10) / 1e6 + 4 * USD_PER_WEB_SEARCH, 9);
    expect(ledger.reservedUsd).toBe(0);
  });

  it('estimates a json_schema request without calling the model', async () => {
    vi.stubEnv('HALE_ESTIMATE', '1');
    const m = mockClient();
    const guarded = capSdkClient(m.client, { rates, tag: 'eval' });
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    };
    const message = await guarded.messages.create({
      ...request,
      output_config: { format: { type: 'json_schema', schema } },
    });
    expect(m.create).not.toHaveBeenCalled();
    expect(m.countTokens).toHaveBeenCalledTimes(1);
    expect(JSON.parse(message.content[0].text)).toEqual({ answer: 'estimate' });
  });

  it('relaxes a forced tool_choice for the free count and sends the original on the call', async () => {
    vi.stubEnv('HALE_MAX_USD', '2');
    const m = mockClient();
    const guarded = capSdkClient(m.client, { rates, tag: 'eval' });
    const tools = [{ name: 'lane', input_schema: { type: 'object' } }];
    const forced = {
      ...request,
      tools,
      tool_choice: { type: 'tool', name: 'lane' },
    };
    await guarded.messages.create(forced);
    expect(m.countTokens.mock.calls[0][0].tool_choice).toEqual({ type: 'auto' });
    expect(m.create.mock.calls[0][0].tool_choice).toEqual({ type: 'tool', name: 'lane' });
    expect(forced.tool_choice).toEqual({ type: 'tool', name: 'lane' });

    await guarded.messages.create({ ...forced, tool_choice: { type: 'any' } });
    expect(m.countTokens.mock.calls[1][0].tool_choice).toEqual({ type: 'auto' });
    expect(m.create.mock.calls[1][0].tool_choice).toEqual({ type: 'any' });

    const auto = { type: 'auto', disable_parallel_tool_use: true };
    await guarded.messages.create({ ...forced, tool_choice: auto });
    expect(m.countTokens.mock.calls[2][0].tool_choice).toEqual(auto);
    expect(m.create.mock.calls[2][0].tool_choice).toEqual(auto);

    await guarded.messages.create({ ...forced, tool_choice: { type: 'none' } });
    expect(m.countTokens.mock.calls[3][0].tool_choice).toEqual({ type: 'none' });
    expect(m.create.mock.calls[3][0].tool_choice).toEqual({ type: 'none' });
  });

  it('books the projection when the call fails after it was sent', async () => {
    vi.stubEnv('HALE_MAX_USD', '2');
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
    const ledger = readLedger();
    expect(ledger.spentUsd).toBeCloseTo((1000 * 2 + 1000 * 10) / 1e6, 9);
    expect(ledger.reservedUsd).toBe(0);
  });
});

/**
 * CACHE-AWARE WORST CASE (914). After call 1, the system prompt is priced at the cache-READ
 * rate only when the previous call with the same prefix reported a cache write or read,
 * started within the TTL, and nothing else is in flight. Otherwise the cache-write rate,
 * as before. The ledger books real usage either way.
 */
describe('cache-aware reservation', () => {
  const cachedRequest = {
    model: 'claude-sonnet-5-5',
    max_tokens: 1000,
    system: [{ type: 'text', text: 'judge rubric', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'score this' }],
  };
  // rates 2 in / 10 out, 1000 counted input tokens, 1000 max out:
  const FULL = (1000 * 2 * 1.25 + 1000 * 10) / 1e6; // 0.0125
  const WARM_800 = (800 * 2 * 0.1 + 200 * 2 * 1.25 + 1000 * 10) / 1e6; // 0.01066

  function seqClient(usages) {
    const countTokens = vi.fn(async () => ({ input_tokens: 1000 }));
    const create = vi.fn(async () => message(usages.shift()));
    return { messages: { countTokens, create } };
  }
  const projections = () =>
    readLedger()
      .log.filter((e) => !e.refused)
      .map((e) => e.projected);

  beforeEach(async () => {
    const { resetPromptCacheState } = await import('../../../web/lib/testing/spend-cap.mjs');
    resetPromptCacheState();
    vi.stubEnv('HALE_MAX_USD', '1');
  });
  afterEach(() => vi.useRealTimers());

  it('discount ON after a recorded cache write, and real cost booked', async () => {
    const client = capSdkClient(
      seqClient([
        { input_tokens: 200, cache_creation_input_tokens: 800, output_tokens: 100 },
        { input_tokens: 200, cache_read_input_tokens: 800, output_tokens: 100 },
        { input_tokens: 200, cache_read_input_tokens: 800, output_tokens: 100 },
      ]),
      { rates },
    );
    await client.messages.create(cachedRequest);
    await client.messages.create(cachedRequest);
    await client.messages.create(cachedRequest);
    expect(projections()[0]).toBeCloseTo(FULL, 10);
    expect(projections()[1]).toBeCloseTo(WARM_800, 10);
    expect(projections()[2]).toBeCloseTo(WARM_800, 10);
    const real = (200 * 2 + 800 * 2 * 1.25 + 100 * 10) / 1e6;
    expect(readLedger().log[0].actual).toBeCloseTo(real, 10);
    expect(readLedger().log[1].cacheReadPricedTokens).toBe(800);
  });

  it('discount OFF when the previous call reported no cache usage', async () => {
    const client = capSdkClient(
      seqClient([
        { input_tokens: 1000, output_tokens: 100 },
        { input_tokens: 1000, output_tokens: 100 },
      ]),
      { rates },
    );
    await client.messages.create(cachedRequest);
    await client.messages.create(cachedRequest);
    expect(projections()).toEqual([FULL, FULL].map((x) => expect.closeTo(x, 10)));
  });

  it('discount OFF once the cache window has expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T21:00:00Z'));
    const client = capSdkClient(
      seqClient([
        { input_tokens: 200, cache_creation_input_tokens: 800, output_tokens: 100 },
        { input_tokens: 200, cache_creation_input_tokens: 800, output_tokens: 100 },
      ]),
      { rates },
    );
    await client.messages.create(cachedRequest);
    vi.setSystemTime(new Date('2026-10-27T21:05:00Z'));
    await client.messages.create(cachedRequest);
    expect(projections()[1]).toBeCloseTo(FULL, 10);
  });

  it('discount OFF for a different prefix, and when no cache_control is sent', async () => {
    const client = capSdkClient(
      seqClient([
        { input_tokens: 200, cache_creation_input_tokens: 800, output_tokens: 100 },
        { input_tokens: 200, cache_creation_input_tokens: 800, output_tokens: 100 },
        { input_tokens: 1000, output_tokens: 100 },
      ]),
      { rates },
    );
    await client.messages.create(cachedRequest);
    await client.messages.create({
      ...cachedRequest,
      system: [{ type: 'text', text: 'other rubric', cache_control: { type: 'ephemeral' } }],
    });
    await client.messages.create({ ...cachedRequest, system: 'judge rubric' });
    expect(projections()[1]).toBeCloseTo(FULL, 10);
    expect(projections()[2]).toBeCloseTo((1000 * 2 + 1000 * 10) / 1e6, 10);
  });

  it('discount OFF while another call is in flight', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const usages = [
      { input_tokens: 200, cache_creation_input_tokens: 800, output_tokens: 100 },
      { input_tokens: 200, cache_creation_input_tokens: 800, output_tokens: 100 },
      { input_tokens: 200, cache_creation_input_tokens: 800, output_tokens: 100 },
    ];
    let n = 0;
    const raw = {
      messages: {
        countTokens: async () => ({ input_tokens: 1000 }),
        create: async () => {
          n += 1;
          if (n === 2) await gate;
          return message(usages.shift());
        },
      },
    };
    const client = capSdkClient(raw, { rates });
    await client.messages.create(cachedRequest);
    const slow = client.messages.create(cachedRequest);
    await new Promise((r) => setTimeout(r, 5));
    const third = client.messages.create(cachedRequest);
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([slow, third]);
    const log = readLedger().log;
    expect(log.map((e) => e.projected)).toContainEqual(expect.closeTo(FULL, 10));
    expect(log.filter((e) => e.projected > WARM_800 + 1e-9)).toHaveLength(2);
  });
});
