// Any live (paid) call needs BOTH a cap and HALE_SPEND_LEDGER. Keys stay unset; every
// "call" here is a mock, so nothing is paid.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_GUARD_ERROR, capSdkClient, cappedCall } from '../../../web/lib/testing/spend-cap.mjs';
import { cacheGet, spendCappedFetch } from './harness.mjs';

const rates = () => ({ input: 2, output: 10 });
const request = {
  model: 'claude-sonnet-5-5',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hi' }],
};
const message = { usage: { input_tokens: 5, output_tokens: 5 } };

function mocks() {
  const countTokens = vi.fn(async () => ({ input_tokens: 5 }));
  const create = vi.fn(async () => message);
  return { countTokens, create, client: { messages: { countTokens, create } } };
}

beforeEach(() => {
  vi.stubEnv('HALE_SPEND_LEDGER', '');
  vi.stubEnv('HALE_MAX_USD', '');
  vi.stubEnv('HALE_ESTIMATE', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('a live call', () => {
  it('with no cap refuses, naming both, and makes no call', async () => {
    vi.stubEnv('HALE_SPEND_LEDGER', join(mkdtempSync(join(tmpdir(), 'lg-')), 'l.json'));
    const m = mocks();
    await expect(capSdkClient(m.client, { rates }).messages.create(request)).rejects.toThrow(
      LIVE_GUARD_ERROR,
    );
    expect(LIVE_GUARD_ERROR).toMatch(/HALE_MAX_USD/);
    expect(LIVE_GUARD_ERROR).toMatch(/HALE_SPEND_LEDGER/);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.countTokens).not.toHaveBeenCalled();
  });

  it('with neither set refuses and makes no call', async () => {
    const call = vi.fn(async () => message);
    await expect(cappedCall({ client: mocks().client, request, call, rates })).rejects.toThrow(
      LIVE_GUARD_ERROR,
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('with the cap but no ledger refuses and makes no call', async () => {
    vi.stubEnv('HALE_MAX_USD', '1');
    const m = mocks();
    await expect(capSdkClient(m.client, { rates }).messages.create(request)).rejects.toThrow(
      LIVE_GUARD_ERROR,
    );
    expect(m.create).not.toHaveBeenCalled();
  });

  it('a gateway fetch with no cap refuses and never sends', async () => {
    const send = vi.fn();
    await expect(spendCappedFetch({ request, send })).rejects.toThrow(LIVE_GUARD_ERROR);
    expect(send).not.toHaveBeenCalled();
  });

  it('with both set proceeds (mocked) and books to the ledger', async () => {
    vi.stubEnv('HALE_MAX_USD', '1');
    vi.stubEnv('HALE_SPEND_LEDGER', join(mkdtempSync(join(tmpdir(), 'lg-')), 'l.json'));
    const m = mocks();
    await expect(capSdkClient(m.client, { rates }).messages.create(request)).resolves.toBe(message);
    expect(m.create).toHaveBeenCalledTimes(1);
  });
});

describe('a cached replay', () => {
  it('works with neither set: reading the cache and wrapping a client make no call', async () => {
    expect(await cacheGet('definitely-not-a-recorded-key')).toBeUndefined();
    const m = mocks();
    expect(() => capSdkClient(m.client, { rates })).not.toThrow();
    expect(m.create).not.toHaveBeenCalled();
  });
});
