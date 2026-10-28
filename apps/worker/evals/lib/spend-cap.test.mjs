import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MISSING_LEDGER_ERROR,
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

  it('installs the lower ceiling on the given ledger before any call', () => {
    vi.stubEnv('HALE_MAX_USD', '2');
    const cap = installSpendCap(['node', 'eval.mjs', '--max-usd=0.4']);
    expect(cap).toBe(0.4);
    expect(process.env.HALE_MAX_USD).toBe('0.4');
    expect(process.env.HALE_SPEND_LEDGER).toBe(join(dir, 'ledger.json'));
  });
});

describe('a live run without HALE_SPEND_LEDGER', () => {
  it('refuses to start, naming the var, and never defaults to /tmp', () => {
    vi.stubEnv('HALE_SPEND_LEDGER', '');
    vi.stubEnv('HALE_MAX_USD', '');
    expect(() => installSpendCap(['node', 'eval.mjs', '--max-usd=0.4'])).toThrow(
      MISSING_LEDGER_ERROR,
    );
    expect(process.env.HALE_SPEND_LEDGER).toBe('');
    expect(process.env.HALE_MAX_USD).toBe('');
  });

  it('refuses an estimate round too', () => {
    vi.stubEnv('HALE_SPEND_LEDGER', '');
    vi.stubEnv('HALE_ESTIMATE', '1');
    expect(() => installSpendCap(['node', 'eval.mjs'])).toThrow(/HALE_SPEND_LEDGER/);
  });

  it('makes no model call when the guard is reached without a ledger', async () => {
    vi.stubEnv('HALE_SPEND_LEDGER', '');
    vi.stubEnv('HALE_MAX_USD', '1');
    const call = vi.fn(async () => ({ usage: { input_tokens: 1, output_tokens: 1 } }));
    const countTokens = vi.fn(async () => ({ input_tokens: 10 }));
    const client = { messages: { countTokens } };
    await expect(cappedCall({ client, rates, request, call, tag: 't' })).rejects.toThrow(
      /HALE_SPEND_LEDGER/,
    );
    expect(call).not.toHaveBeenCalled();
    expect(countTokens).not.toHaveBeenCalled();
  });

  it('leaves an uncapped cached replay alone (no ledger needed)', () => {
    vi.stubEnv('HALE_SPEND_LEDGER', '');
    vi.stubEnv('HALE_MAX_USD', '');
    expect(installSpendCap(['node', 'eval.mjs', '--cached-only'])).toBeNull();
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
  it('refuses a live call when no cap is set, before counting or calling', async () => {
    const m = mockClient();
    await expect(
      cappedCall({
        client: m.client,
        request,
        call: () => m.client.messages.create(request),
        rates,
      }),
    ).rejects.toThrow(/HALE_MAX_USD.*HALE_SPEND_LEDGER/);
    expect(m.countTokens).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
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
