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
